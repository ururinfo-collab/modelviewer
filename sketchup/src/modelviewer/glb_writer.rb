# Writes the SketchUp model (or the selection) as one binary glTF (.glb) for the phone viewer:
# a node per group / component instance (name, tag, definition, attributes in extras), meshes
# shared between copies of a component, colours and textures, and in the scene extras the
# saved scenes (cameras, hidden tags / objects, shadow time), the tag list and the geo-location.
# Units stay SketchUp inches, Z up; the root node scales to metres and turns to glTF's Y up.
require 'json'
require 'tmpdir'
require 'fileutils'

module ModelViewer
  class GlbWriter
    INCH = 0.0254
    FLOAT = 5126
    USHORT = 5123
    UINT = 5125

    attr_reader :stats

    def initialize(model, selection_only: false)
      @model = model
      @selection_only = selection_only
      @bin = String.new(encoding: Encoding::BINARY)
      @views = []
      @accessors = []
      @meshes = []
      @nodes = []
      @materials = []
      @textures = []
      @images = []
      @mat_index = {}
      @mesh_cache = {}
      @tex_dir = Dir.mktmpdir('modelviewer_tex')
      @stats = { 'objects' => 0, 'triangles' => 0, 'materials' => 0, 'textures' => 0 }
    end

    def write(path)
      t0 = Time.now
      root = { 'name' => title, 'matrix' => [INCH, 0, 0, 0, 0, 0, -INCH, 0, 0, INCH, 0, 0, 0, 0, 0, 1],
               'extras' => { 'mv' => { 'root' => true, 'name' => title } } }
      @nodes << root
      kids = []
      ents = @selection_only ? @model.selection.to_a : @model.entities.to_a
      faces = walk(ents, nil, kids)
      mesh = mesh_for(:top, faces, nil)
      root['mesh'] = mesh if mesh
      root['children'] = kids unless kids.empty?
      write_glb(path, gltf)
      @stats['seconds'] = (Time.now - t0).round(1)
      @stats['bytes'] = File.size(path)
      @stats
    ensure
      FileUtils.rm_rf(@tex_dir) if @tex_dir
    end

    private

    def title
      t = @model.title.to_s
      t.empty? ? 'Untitled' : t
    end

    # child nodes go into kids; returns the loose faces of this level
    def walk(entities, inherited, kids)
      faces = []
      entities.each do |e|
        case e
        when Sketchup::Face then faces << e
        when Sketchup::Group, Sketchup::ComponentInstance then kids << instance_node(e, inherited)
        end
      end
      faces
    end

    def instance_node(e, inherited)
      defn = e.definition
      mat = e.material || inherited
      comp = e.is_a?(Sketchup::ComponentInstance)
      name = e.name.to_s
      name = comp ? defn.name : 'Group' if name.empty?
      mv = { 'name' => name, 'tag' => tag_name(e.layer), 'type' => comp ? 'component' : 'group', 'pid' => e.persistent_id }
      mv['def'] = defn.name if comp
      mv['hidden'] = true if e.hidden?
      mv['mat'] = e.material.display_name if e.material
      vol = (e.volume rescue -1)
      mv['vol'] = (vol * INCH**3).round(4) if vol && vol > 0
      attrs = attributes(e)
      mv['attrs'] = attrs unless attrs.empty?
      node = { 'name' => name, 'matrix' => e.transformation.to_a.map(&:to_f), 'extras' => { 'mv' => mv } }
      index = @nodes.size
      @nodes << node
      @stats['objects'] += 1
      Sketchup.status_text = "Model Viewer: #{@stats['objects']} objects..." if (@stats['objects'] % 250).zero?
      kids = []
      faces = walk(defn.entities, mat, kids)
      mesh = mesh_for(defn, faces, mat)
      node['mesh'] = mesh if mesh
      node['children'] = kids unless kids.empty?
      node.delete('matrix') if identity?(node['matrix'])
      index
    end

    def identity?(m)
      m == [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    end

    def tag_name(layer)
      return 'Untagged' unless layer
      layer.respond_to?(:display_name) ? layer.display_name : layer.name
    end

    # scalar attributes of the instance and its definition (IFC data, dynamic component values...)
    def attributes(e)
      out = {}
      [e, e.definition].each do |x|
        (x.attribute_dictionaries || []).each do |d|
          next if d.name =~ /\A(SU_|GSU_|SketchUp|_)/
          d.each_pair do |k, v|
            next if k.to_s.start_with?('_') || out.size >= 40
            v = v.to_s if v.is_a?(Symbol)
            next unless v.is_a?(String) || v.is_a?(Numeric) || v == true || v == false
            next if v.is_a?(String) && (v.empty? || v.size > 160)
            out["#{d.name}: #{k}"] = v.is_a?(Float) ? v.round(4) : v
          end
        end
      end
      out
    end

    # one mesh per definition (and inherited material): copies of a component share it
    def mesh_for(owner, faces, inherited)
      return nil if faces.empty?
      key = [owner.object_id, inherited ? inherited.object_id : 0]
      return @mesh_cache[key] if @mesh_cache.key?(key)

      groups = {}
      faces.each do |f|
        next if f.hidden?
        mat = f.material || inherited || f.back_material
        own_tex = mat && mat.texture && f.material == mat
        pm = f.mesh(own_tex ? 1 : 0)
        g = (groups[mat] ||= { pos: [], uv: [], idx: [], map: {}, tex: mat && mat.texture ? true : false })
        pts = pm.points
        normal = f.normal
        pm.polygons.each do |poly|
          next if poly.size < 3
          ids = poly.map do |i|
            i = i.abs
            p = pts[i - 1]
            uv = g[:tex] ? (own_tex ? uv_of(pm, i) : planar_uv(p, normal, mat.texture)) : nil
            k = uv ? [p.x.round(4), p.y.round(4), p.z.round(4), uv[0].round(5), uv[1].round(5)] : [p.x.round(4), p.y.round(4), p.z.round(4)]
            g[:map][k] ||= begin
              g[:pos].push(p.x.to_f, p.y.to_f, p.z.to_f)
              g[:uv].push(uv[0], uv[1]) if uv
              g[:pos].size / 3 - 1
            end
          end
          g[:idx].push(ids[0], ids[1], ids[2])
        end
      end
      prims = groups.map { |mat, g| g[:idx].empty? ? nil : primitive(g, mat) }.compact
      @mesh_cache[key] = if prims.empty?
                           nil
                         else
                           @meshes << { 'primitives' => prims }
                           @meshes.size - 1
                         end
    end

    def uv_of(pm, i)
      q = pm.uv_at(i, true)
      w = q.z.to_f.abs < 1e-9 ? 1.0 : q.z.to_f
      [q.x.to_f / w, 1.0 - q.y.to_f / w]
    end

    # default-material faces of a painted group: project the texture on the face's main plane
    def planar_uv(p, n, tex)
      w = tex.width.to_f.nonzero? || 1.0
      h = tex.height.to_f.nonzero? || 1.0
      ax, ay, az = n.x.abs, n.y.abs, n.z.abs
      u, v = if az >= ax && az >= ay then [p.x, p.y]
             elsif ax >= ay then [p.y, p.z]
             else [p.x, p.z]
             end
      [u.to_f / w, 1.0 - v.to_f / h]
    end

    def primitive(g, mat)
      pos = g[:pos]
      xs, ys, zs = (0...pos.size / 3).map { |i| pos[3 * i] }, (0...pos.size / 3).map { |i| pos[3 * i + 1] }, (0...pos.size / 3).map { |i| pos[3 * i + 2] }
      count = pos.size / 3
      attrs = { 'POSITION' => accessor(pos.pack('e*'), FLOAT, count, 'VEC3', 34962, [xs.min, ys.min, zs.min], [xs.max, ys.max, zs.max]) }
      attrs['TEXCOORD_0'] = accessor(g[:uv].pack('e*'), FLOAT, count, 'VEC2', 34962) unless g[:uv].empty?
      big = count > 65535
      idx = accessor(g[:idx].pack(big ? 'V*' : 'v*'), big ? UINT : USHORT, g[:idx].size, 'SCALAR', 34963)
      @stats['triangles'] += g[:idx].size / 3
      { 'attributes' => attrs, 'indices' => idx, 'material' => material_index(mat), 'mode' => 4 }
    end

    def accessor(data, type, count, kind, target, min = nil, max = nil)
      a = { 'bufferView' => view(data, target), 'componentType' => type, 'count' => count, 'type' => kind }
      if min
        a['min'] = min
        a['max'] = max
      end
      @accessors << a
      @accessors.size - 1
    end

    def view(data, target = nil)
      @bin << ("\0" * ((4 - @bin.bytesize % 4) % 4))
      v = { 'buffer' => 0, 'byteOffset' => @bin.bytesize, 'byteLength' => data.bytesize }
      v['target'] = target if target
      @bin << data
      @views << v
      @views.size - 1
    end

    def linear(c)
      c /= 255.0
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055)**2.4
    end

    def material_index(mat)
      key = mat || :default
      return @mat_index[key] if @mat_index.key?(key)

      m = { 'doubleSided' => true }
      if mat
        c = mat.color
        a = mat.alpha.to_f
        pbr = { 'baseColorFactor' => [linear(c.red), linear(c.green), linear(c.blue), a], 'metallicFactor' => 0.0, 'roughnessFactor' => 0.85 }
        if mat.texture && (t = texture_index(mat))
          pbr['baseColorTexture'] = { 'index' => t }
          pbr['baseColorFactor'] = [1.0, 1.0, 1.0, a]
        end
        m['name'] = mat.display_name
        m['alphaMode'] = 'BLEND' if a < 0.999
      else
        c = @model.rendering_options['FaceFrontColor'] || Sketchup::Color.new(255, 255, 255)
        pbr = { 'baseColorFactor' => [linear(c.red), linear(c.green), linear(c.blue), 1.0], 'metallicFactor' => 0.0, 'roughnessFactor' => 0.85 }
        m['name'] = 'Default'
      end
      m['pbrMetallicRoughness'] = pbr
      @materials << m
      @stats['materials'] += 1
      @mat_index[key] = @materials.size - 1
    end

    def texture_index(mat)
      tex = mat.texture
      ext = File.extname(tex.filename.to_s).downcase
      ext = '.png' unless %w[.jpg .jpeg .png].include?(ext)
      file = File.join(@tex_dir, "t#{@images.size}#{ext}")
      colorized = mat.respond_to?(:materialType) && mat.materialType == 2
      ok = (tex.write(file, colorized) rescue false)
      return nil unless ok && File.exist?(file)

      @images << { 'bufferView' => view(File.binread(file)), 'mimeType' => ext == '.png' ? 'image/png' : 'image/jpeg', 'name' => mat.display_name }
      @textures << { 'source' => @images.size - 1, 'sampler' => 0 }
      @stats['textures'] += 1
      @textures.size - 1
    end

    # ---- model-level data for the viewer --------------------------------------

    def meta
      {
        'title' => title, 'source' => 'sketchup', 'file' => @model.path, 'exported' => Time.now.strftime('%Y-%m-%d %H:%M'),
        'selectionOnly' => @selection_only, 'tags' => tags, 'scenes' => scenes, 'location' => location,
        'sketchup' => Sketchup.version
      }
    end

    def tags
      @model.layers.map do |l|
        t = { 'name' => tag_name(l), 'visible' => l.visible?, 'color' => l.color.to_a[0, 3] }
        if l.respond_to?(:folder) && l.folder
          path = []
          f = l.folder
          while f.is_a?(Sketchup::LayerFolder)
            path.unshift(f.name)
            f = f.respond_to?(:folder) ? f.folder : nil
          end
          t['folder'] = path.join(' / ')
        end
        t
      end
    end

    def local_time(t)
      t.respond_to?(:getutc) ? t.getutc.strftime('%Y-%m-%dT%H:%M') : nil   # SketchUp keeps the clock time as UTC
    end

    def location
      si = @model.shadow_info
      { 'lat' => si['Latitude'].to_f, 'lon' => si['Longitude'].to_f, 'tz' => si['TZOffset'].to_f, 'north' => si['NorthAngle'].to_f,
        'city' => si['City'].to_s, 'country' => si['Country'].to_s, 'time' => local_time(si['ShadowTime']), 'shadows' => si['DisplayShadows'] ? true : false }
    end

    def scenes
      @model.pages.map do |pg|
        cam = pg.camera
        s = { 'name' => pg.name, 'eye' => cam.eye.to_a, 'target' => cam.target.to_a, 'up' => cam.up.to_a,
              'persp' => cam.perspective?, 'useCamera' => pg.use_camera? }
        s['fov'] = cam.fov.to_f if cam.perspective?
        s['aspect'] = cam.aspect_ratio.to_f if cam.aspect_ratio.to_f > 0
        s['description'] = pg.description.to_s unless pg.description.to_s.empty?
        s['hiddenTags'] = pg.layers.map { |l| tag_name(l) } if pg.use_hidden_layers?
        if pg.respond_to?(:use_hidden_objects?) && pg.use_hidden_objects? && pg.respond_to?(:hidden_entities)
          s['hidden'] = pg.hidden_entities.select { |x| x.respond_to?(:persistent_id) }.map(&:persistent_id)
        end
        if pg.use_shadow_info?
          si = pg.shadow_info
          s['shadow'] = { 'time' => local_time(si['ShadowTime']), 'on' => si['DisplayShadows'] ? true : false }
        end
        s
      end
    end

    # ---- file ----------------------------------------------------------------

    def gltf
      g = {
        'asset' => { 'version' => '2.0', 'generator' => "ModelViewer SketchUp exporter #{VERSION}" },
        'scene' => 0,
        'scenes' => [{ 'name' => title, 'nodes' => [0], 'extras' => { 'mv' => meta } }],
        'nodes' => @nodes, 'meshes' => @meshes, 'materials' => @materials,
        'accessors' => @accessors, 'bufferViews' => @views,
      }
      g['buffers'] = [{ 'byteLength' => padded_bin.bytesize }] unless @bin.empty?
      unless @images.empty?
        g['images'] = @images
        g['textures'] = @textures
        g['samplers'] = [{ 'magFilter' => 9729, 'minFilter' => 9987, 'wrapS' => 10497, 'wrapT' => 10497 }]
      end
      %w[meshes materials accessors bufferViews].each { |k| g.delete(k) if g[k].empty? }
      g
    end

    def padded_bin
      @bin << ("\0" * ((4 - @bin.bytesize % 4) % 4))
      @bin
    end

    def write_glb(path, g)
      json = JSON.generate(g).b
      json << (' ' * ((4 - json.bytesize % 4) % 4))
      bin = padded_bin
      total = 12 + 8 + json.bytesize + (bin.empty? ? 0 : 8 + bin.bytesize)
      tmp = "#{path}.part"
      File.open(tmp, 'wb') do |f|
        f.write(['glTF', 2, total].pack('a4VV'))
        f.write([json.bytesize, 0x4E4F534A].pack('VV'))
        f.write(json)
        unless bin.empty?
          f.write([bin.bytesize, 0x004E4942].pack('VV'))
          f.write(bin)
        end
      end
      File.delete(path) if File.exist?(path)
      File.rename(tmp, path)     # the phone never sees a half-written file
    end
  end
end
