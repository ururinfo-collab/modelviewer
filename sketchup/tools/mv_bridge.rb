# Lets Claude look into the open model while it works on the flush-joints script, without you copying output.
# Load once in Window > Ruby Console:
#     load 'C:/Users/ARKAR/Desktop/ModelViewer/sketchup/tools/mv_bridge.rb'
# It runs the small .rb files Claude drops in ModelViewer/sketchup/bridge/ and writes the answers next to them.
# MVBridge.stop ends it. Closing SketchUp ends it too, and it stops by itself after 2 hours without a request.
require 'stringio'

module MVBridge
  DIR = File.join(File.dirname(File.dirname(File.expand_path(__FILE__))), 'bridge') unless const_defined?(:DIR)
  IDLE = 7200

  module_function

  def start
    stop
    Dir.mkdir(DIR) unless Dir.exist?(DIR)
    Dir.glob(File.join(DIR, '*')).each { |f| File.delete(f) }
    @last = Time.now
    @busy = false
    File.write(File.join(DIR, 'alive.txt'), "#{Sketchup.active_model.title} #{Time.now}")
    @timer = UI.start_timer(0.5, true) { tick }
    puts "Bridge on: Claude can now look at '#{Sketchup.active_model.title}'. MVBridge.stop ends it."
  end

  def stop
    UI.stop_timer(@timer) if @timer
    @timer = nil
    path = File.join(DIR, 'alive.txt')
    File.delete(path) if File.exist?(path)
  end

  def tick
    return if @busy
    @busy = true
    Dir.glob(File.join(DIR, 'cmd_*.rb')).sort.each do |path|
      name = File.basename(path, '.rb').sub('cmd_', '')
      code = File.read(path, encoding: 'UTF-8')
      File.delete(path)
      out = StringIO.new
      old = $stdout
      $stdout = out
      begin
        res = TOPLEVEL_BINDING.eval(code, path)
        out.puts "=> #{res.inspect[0, 4000]}"
      rescue Exception => e # rubocop:disable Lint/RescueException
        out.puts "ERROR #{e.class}: #{e.message}", *e.backtrace.first(10)
      ensure
        $stdout = old
      end
      tmp = File.join(DIR, "out_#{name}.tmp")
      File.write(tmp, out.string)
      File.rename(tmp, File.join(DIR, "out_#{name}.txt"))
      @last = Time.now
    end
    stop if Time.now - @last > IDLE
  ensure
    @busy = false
  end
end

MVBridge.start
