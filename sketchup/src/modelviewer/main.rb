# Model Viewer main: toolbar, menu, dialog, export and the Wi-Fi server.
require 'sketchup.rb'
require 'json'
require 'socket'
require 'fileutils'

module ModelViewer
  PLUGIN_DIR = File.dirname(__FILE__)
  Sketchup.require(File.join(PLUGIN_DIR, 'paths'))
  Sketchup.require(File.join(PLUGIN_DIR, 'glb_writer'))

  PORT = 8765
  PREF = 'ModelViewer'.freeze

  def self.exports_dir
    d = Sketchup.read_default(PREF, 'exports', '').to_s
    d.empty? ? File.join(ROOT, 'exports') : d
  end

  def self.export_name(model)
    base = model.path.empty? ? 'Untitled' : File.basename(model.path, '.skp')
    "#{base.gsub(/[^\w.\-]+/, '_')}.glb"
  end

  # ---- dialog -----------------------------------------------------------------

  def self.dialog
    return @dialog if @dialog

    @dialog = UI::HtmlDialog.new(
      dialog_title: 'Model Viewer', preferences_key: 'ModelViewer.dialog', scrollable: true, resizable: true,
      width: 460, height: 640, min_width: 380, min_height: 480, style: UI::HtmlDialog::STYLE_DIALOG
    )
    @dialog.set_file(File.join(PLUGIN_DIR, 'ui', 'dialog.html'))
    @dialog.add_action_callback('ready') { |_c| push_state }
    @dialog.add_action_callback('export') { |_c, json| export(JSON.parse(json)) }
    @dialog.add_action_callback('server') { |_c, on| on == 'on' ? start_server : stop_server; push_state }
    @dialog.add_action_callback('openFolder') { |_c| FileUtils.mkdir_p(exports_dir); UI.openURL("file:///#{exports_dir.tr('\\', '/')}") }
    @dialog.add_action_callback('pickFolder') { |_c| pick_folder }
    @dialog.add_action_callback('openUrl') { |_c, url| UI.openURL(url) if url =~ %r{\Ahttps?://} }
    @dialog.set_on_closed { @dialog = nil }
    @dialog
  end

  def self.show
    dialog.visible? ? dialog.bring_to_front : dialog.show
    push_state
  end

  def self.js(fn, data)
    @dialog&.execute_script("MV.#{fn}(#{JSON.generate(data)})")
  end

  def self.push_state
    model = Sketchup.active_model
    out = File.join(exports_dir, export_name(model))
    js('setState', {
         'model' => model.title.to_s.empty? ? 'Untitled' : model.title, 'saved' => !model.path.empty?,
         'selection' => model.selection.length, 'scenes' => model.pages.size, 'folder' => exports_dir,
         'file' => out, 'exists' => File.exist?(out), 'size' => File.exist?(out) ? File.size(out) : 0,
         'mtime' => File.exist?(out) ? File.mtime(out).strftime('%d %b %H:%M') : '',
         'server' => server_running?, 'urls' => lan_urls, 'python' => python_path ? true : false
       })
  end

  def self.pick_folder
    dir = UI.select_directory(title: 'Folder for phone exports')
    return unless dir

    Sketchup.write_default(PREF, 'exports', dir)
    stop_server if server_running?
    push_state
  end

  # ---- export -----------------------------------------------------------------

  def self.export(opts)
    model = Sketchup.active_model
    sel = opts['selection'] && model.selection.length > 0
    FileUtils.mkdir_p(exports_dir)
    name = export_name(model)
    name = name.sub(/\.glb\z/, '_selection.glb') if sel
    path = File.join(exports_dir, name)
    js('status', { 'busy' => true, 'message' => 'Exporting...' })
    # let the dialog paint "Exporting..." before SketchUp is busy
    UI.start_timer(0.05, false) do
      begin
        stats = GlbWriter.new(model, selection_only: sel).write(path)
        Sketchup.status_text = ''
        start_server if opts['serve'] && !server_running?
        js('status', { 'done' => true, 'file' => path, 'stats' => stats })
      rescue StandardError => e
        js('status', { 'error' => "Export failed: #{e.message}" })
        puts e.full_message
      end
      push_state
    end
  end

  # ---- Wi-Fi server (tools/serve.py, run hidden with pythonw) -------------------

  def self.python_path
    cands = ENV['PATH'].to_s.split(File::PATH_SEPARATOR).map { |d| File.join(d, 'pythonw.exe') }
    cands << PYTHONW if defined?(PYTHONW)
    cands.find { |p| File.exist?(p) && p !~ /WindowsApps/i }
  end

  def self.server_running?
    s = TCPSocket.new('127.0.0.1', PORT)
    s.close
    true
  rescue StandardError
    false
  end

  def self.start_server
    return true if server_running?

    py = python_path
    unless py
      js('status', { 'error' => 'Python was not found, so the Wi-Fi link cannot start. Copy the .glb to the phone instead.' })
      return false
    end
    @server_pid = Process.spawn(py, File.join(ROOT, 'tools', 'serve.py'), '--port', PORT.to_s, '--exports', exports_dir)
    Process.detach(@server_pid)
    10.times do
      sleep 0.2
      break if server_running?
    end
    server_running?
  rescue StandardError => e
    js('status', { 'error' => "Could not start the Wi-Fi link: #{e.message}" })
    false
  end

  def self.stop_server
    if @server_pid
      Process.kill('KILL', @server_pid) rescue nil
      @server_pid = nil
    else
      # started outside SketchUp (Serve to phone.bat): leave it to its own window
      js('status', { 'message' => 'The Wi-Fi link was started outside SketchUp; close its window to stop it.' }) if server_running?
    end
  end

  def self.lan_urls
    Socket.ip_address_list.select { |a| a.ipv4? && a.ipv4_private? }.map { |a| "http://#{a.ip_address}:#{PORT}/" }
  rescue StandardError
    []
  end

  class QuitObserver < Sketchup::AppObserver
    def onQuit
      ModelViewer.stop_server
    end
  end

  # ---- toolbar and menu -------------------------------------------------------

  unless file_loaded?(__FILE__)
    cmd = UI::Command.new('Model Viewer') { show }
    icon = File.join(PLUGIN_DIR, 'icons', 'modelviewer.svg')
    cmd.small_icon = icon
    cmd.large_icon = icon
    cmd.tooltip = 'Model Viewer: export for phone'
    cmd.status_bar_text = 'Export this model for the Model Viewer phone app and send it over Wi-Fi'
    UI.menu('Extensions').add_submenu('Model Viewer').add_item(cmd)
    tb = UI::Toolbar.new('Model Viewer')
    tb.add_item(cmd)
    tb.get_last_state == TB_NEVER_SHOWN ? tb.show : tb.restore
    Sketchup.add_observer(QuitObserver.new)
    file_loaded(__FILE__)
  end
end
