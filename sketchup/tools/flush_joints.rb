# Flush joints for SketchUp: the "one plastered surface" of Model Viewer, applied to the model itself.
#
#  - Hides the lines where parts meet flush: wall panels, a wall and a column or beam, the gable panel on the beam,
#    a slab edge in the wall face. Real corners, and frames, sills and bands that stand proud, keep their lines.
#  - Faces that run on flush into a wall face (column, beam, slab edge, gable panel) get the wall's paint.
#    Walls keep their own colours.
#  - Restore puts every hidden line and every colour back (also after saving).
#
# Use: Window > Ruby Console, then
#     load 'C:/Users/ARKAR/Desktop/ModelViewer/sketchup/tools/flush_joints.rb'
#     MVJoints.preview     # counts only, changes nothing
#     MVJoints.apply       # one Undo step (Edit > Undo takes it back)
#     MVJoints.restore     # every line and colour back as it was
#     MVJoints.export      # save a copy with all of it applied (<name>_clean.skp), optionally with the colours
#                          # from a Model Viewer look file (Save › Save file for SketchUp); save your model first,
#                          # it is opened again exactly as saved afterwards
#     MVJoints.flicker_preview / MVJoints.flicker_apply / MVJoints.flicker_restore
#                          # flickering faces: where a smaller part's face overlaps a bigger part's face in the same
#                          # plane, it is hidden (fully covered, same paint) or moved 1 mm forward (one Undo step;
#                          # restore puts them back).
# Best order: MVJoints.apply, then MVJoints.flicker_apply, then MVJoints.apply once more. The first pass gives
# flush posts the wall's paint, so the flicker fix can simply hide their covered faces; the second pass hides the
# small lines left where a face had to move 1 mm forward.
# Loading also adds Extensions > Flush joints with the same commands.
#
# How a joint is found: along each edge line, every face that touches it (any group or component) is looked at.
# A stretch is a joint when the faces there carry on across the line in one plane, and the rest lie back to back.
# Parts may be up to 15 mm apart. An edge lying inside another part's face (a column passing a beam end) also goes
# when its side runs into the solid. A component's edge is hidden only if that is true for every copy of it.
require 'set'
require 'json'
require 'tmpdir'

module MVJoints
  # loading the file again (after an update) replaces these quietly
  %i[ATTR TOL SAME WALL NOT_WALL PAINT NO_PAINT PUSH NEIGH CELL].each { |k| remove_const(k) if const_defined?(k, false) }
  ATTR = 'mv_joints'
  TOL = 15.mm                       # SketchUp lengths are inches; 15 mm
  SAME = 0.999
  # parts whose paint spreads to flush columns, beams and slab edges (name or tag); edit to suit your naming
  WALL = /\bwall\b|walls and partitions|plaster|parapet|partition/i
  NOT_WALL = /tile|skirting|frame|window|door|sill|coping|footing/i
  # parts that take the wall's paint where they run on flush into it (name or tag): the structure behind the plaster
  PAINT = /S-COL|S-BEAM|S-SLAB|S-STEEL|column|beam|lintel|slab|panel|gable/i
  NO_PAINT = /tile|skirting|frame|window|door|sill|coping|footing|band|finish|fill|hard ?core|sand|railing/i

  module_function

  # ---- flicker ----------------------------------------------------------------------------------------------
  # Where a smaller part's visible face lies in the same plane as a bigger part's face and overlaps it (a post in
  # a wall face, a column passing a beam end), SketchUp draws both and they flicker as you orbit. SketchUp has no
  # setting for which wins, so one of them has to go: see flicker() below.
  PUSH = 1.mm

  def flicker_preview
    flicker(dry: true)
  end

  def flicker_apply
    flicker(dry: false)
  end

  def flicker_restore
    model = Sketchup.active_model
    model.start_operation('Restore flicker fix', true)
    pulled = shown = 0
    model.definitions.each do |d|
      d.entities.grep(Sketchup::Face).each do |f|
        if f.get_attribute(ATTR, 'hid_face')
          f.hidden = false
          f.delete_attribute(ATTR, 'hid_face')
          shown += 1
        end
        dist = f.get_attribute(ATTR, 'pushed')
        next unless dist
        f.delete_attribute(ATTR, 'pushed')
        f.pushpull(-dist)
        pulled += 1
      end
    end
    model.commit_operation
    UI.messagebox("Showed #{shown} faces again and pulled #{pulled} faces back by #{PUSH.to_mm.round(1)} mm.")
  end

  def flicker(dry:)
    model = Sketchup.active_model
    t0 = Time.now
    conts = []
    counts = Hash.new(0)
    collect(model.entities, Geom::Transformation.new, conts, counts)
    @faces = index_faces(conts)
    conts.each do |c|
      bb = c[:defn].bounds
      c[:vol] = (bb.width * bb.height * bb.depth).to_f
    end
    # Two remedies. Fully covered by the bigger face and the same paint (a post in a painted wall, also after the
    # joint fix gave it the wall's paint): hide the smaller face, the bigger one shows the same there, no new line.
    # Partly covered, or another material (a stone-clad column in a painted wall): push it 1 mm forward, it keeps
    # its own look in front.
    votes = {}                                         # [definition, face] -> [action, push distance, copies]
    conts.each do |c|
      c[:defn].entities.grep(Sketchup::Face).each do |f|
        next if f.hidden?
        out = outward(c, f)
        next unless out
        cover = face_samples(f, c[:tr]).map { |pt| loses?(pt, out, c) }
        next if cover.none?
        g, gc = cover.compact.first
        same = (g.material || gc[:inst].material) == (f.material || c[:inst].material)
        action = cover.all? && same ? :hide : :push
        local = f.normal % (c[:defn].bounds.center - f.vertices[0].position)
        dist = local.positive? ? -PUSH : PUSH          # along the face's own normal, away from the part
        rec = (votes[[c[:defn], f]] ||= [action, dist, Set.new])
        rec[2] << c[:id]
      end
    end
    todo = votes.select { |(d, _), (_, _, ids)| ids.size >= counts[d] }.map { |(_, f), (a, dist, _)| [f, a, dist] }
    hides = todo.count { |_, a, _| a == :hide }
    pushes = todo.size - hides
    secs = (Time.now - t0).round(1)
    if dry
      UI.messagebox("Preview (nothing changed):\n#{todo.size} faces flicker against a bigger part's face:\n" \
                    "#{hides} would be hidden (fully covered, same paint)\n#{pushes} would move #{PUSH.to_mm.round(1)} mm forward\n" \
                    "(#{secs} s)\n\nRun MVJoints.flicker_apply to do it.")
      return
    end
    model.start_operation('Flicker fix', true) unless @export     # a clean copy runs inside its own operation
    begin
      todo.each do |f, action, dist|
        next unless f.valid?
        if action == :hide
          f.hidden = true
          f.set_attribute(ATTR, 'hid_face', true)
        else
          f.set_attribute(ATTR, 'pushed', dist)
          f.pushpull(dist)
        end
      end
      model.commit_operation unless @export
    rescue StandardError => e
      model.abort_operation unless @export
      raise e
    end
    return [hides, pushes] if @export
    UI.messagebox("Flicker fix: hid #{hides} fully covered faces and moved #{pushes} faces #{PUSH.to_mm.round(1)} mm forward (#{secs} s).\n" \
                  "Edit > Undo takes it back; MVJoints.flicker_restore puts them back later.")
  end

  # the face's normal in the world, turned to point away from its part (faces are often reversed in SketchUp)
  def outward(c, f)
    n = norm(v3(f.normal.transform(c[:tr])))
    return nil unless n
    p = v3(f.vertices[0].position.transform(c[:tr]))
    dot(sub(c[:centre].to_a, p), n).positive? ? n.map { |x| -x } : n
  end

  # points spread over the face (centres of its triangles, and each corner moved a little inward), in the world
  def face_samples(f, tr)
    mesh = f.mesh(0)
    pts = []
    vs = f.outer_loop.vertices.map(&:position)
    cx = vs.sum(&:x) / vs.size
    cy = vs.sum(&:y) / vs.size
    cz = vs.sum(&:z) / vs.size
    vs.first(24).each do |p|
      q = Geom::Point3d.new(p.x + (cx - p.x) * 0.04, p.y + (cy - p.y) * 0.04, p.z + (cz - p.z) * 0.04)
      pts << v3(q.transform(tr)) if f.classify_point(q) == Sketchup::Face::PointInside
    end
    (1..mesh.count_polygons).step([mesh.count_polygons / 8, 1].max) do |i|
      ids = mesh.polygon_at(i).map(&:abs)
      ps = ids.map { |k| mesh.point_at(k) }
      cx = ps.sum(&:x) / ps.size
      cy = ps.sum(&:y) / ps.size
      cz = ps.sum(&:z) / ps.size
      pts << v3(Geom::Point3d.new(cx, cy, cz).transform(tr))
    end
    pts
  end

  # does a bigger part's face, in the same plane and facing the same way, cover this point?
  def loses?(pt, out, own)
    n = out
    s = n.find { |x| x.abs > 1e-9 } || 1.0
    s = s.negative? ? -1.0 : 1.0
    base = n.map { |x| (x * s * 100).round }
    o = (dot(n, pt) * s / 0.2).round
    cell = pt.map { |x| (x / CELL).floor }
    (-1..1).each do |k|
      (@faces[[*base, o + k, *cell]] || []).each do |c, g|
        next if c.equal?(own)
        next unless c[:vol] > own[:vol] || (c[:vol] == own[:vol] && c[:id] > own[:id])
        go = outward(c, g)
        next unless go && dot(go, out) > SAME
        lp = Geom::Point3d.new(*pt).transform(c[:inv])
        next unless (g.plane[0] * lp.x + g.plane[1] * lp.y + g.plane[2] * lp.z + g.plane[3]).abs < 0.04
        return [g, c] if g.classify_point(lp) == Sketchup::Face::PointInside
      end
    end
    nil
  end

  # Why is this line still there? Double-click into the group, select one line, run MVJoints.why.
  def why
    model = Sketchup.active_model
    e = model.selection.grep(Sketchup::Edge).first
    return UI.messagebox('Double-click into the group, click one line that should have gone, then run MVJoints.why') unless e
    @faces = nil
    conts = []
    counts = Hash.new(0)
    collect(model.entities, Geom::Transformation.new, conts, counts)
    buckets = {}
    mine = nil
    conts.each do |c|
      c[:defn].entities.grep(Sketchup::Edge).each do |x|
        next if ((x.soft? || x.smooth?) && !corner?(x)) || (x.hidden? && !x.get_attribute(ATTR, 'hidden'))
        r = edge_record(c, x)
        next unless r
        (buckets[r[:key]] ||= []) << r
        mine ||= r if x == e
      end
    end
    return UI.messagebox("That line's group was not found among the visible groups (hidden tag?).") unless mine
    c = mine[:c]
    lines = ["Part: #{c[:inst].name} (#{c[:defn].name}), copies: #{counts[c[:defn]]}, wall: #{c[:wall]}",
             "Line: #{(mine[:len] * 25.4).round} mm, faces on it: #{e.faces.size}, directions found: #{mine[:dirs].size}"]
    near = []
    NEIGH.each do |dx, dy, dz|
      k = mine[:key].dup
      k[3] += dx; k[4] += dy; k[5] += dz
      (buckets[k] || []).each do |fr|
        next if fr.equal?(mine) || dot(fr[:d], mine[:d]).abs < 1 - 1e-6
        q = sub(fr[:p0], mine[:p0])
        off = add(q, mine[:d], -dot(q, mine[:d]))
        dist = Math.sqrt(dot(off, off))
        near << "  #{fr[:c][:inst].name}: #{(dist * 25.4).round(1)} mm off the line, #{fr[:dirs].size} faces, " \
                "directions #{fr[:dirs].map { |dd, _| dd.map { |v| v.round(2) } }.inspect}" if dist < TOL * 3
      end
    end
    lines << "Own directions: #{mine[:dirs].map { |dd, _| dd.map { |v| v.round(2) } }.inspect}"
    lines << "Lines on the same line nearby (#{near.size}):" << near.first(8)
    s = merge(sweep(mine, buckets, {}))
    cv = merge(covered(mine, conts))
    lines << "Joint stretches from matching: #{s.map { |a, b| [(a * 25.4).round, (b * 25.4).round] }.inspect} mm"
    lines << "Stretches inside another part's face: #{cv.map { |a, b| [(a * 25.4).round, (b * 25.4).round] }.inspect} mm"
    text = lines.flatten.join("\n")
    puts text
    UI.messagebox(text)
  end

  def preview
    run(dry: true)
  end

  def apply
    run(dry: false)
  end

  # ---- clean copy -------------------------------------------------------------------------------------------
  # Saves a copy of the model with everything applied (the colours from a Model Viewer look file if you pick
  # one, then joints, flicker fix, joints again) under a new name, for showing or sending. Your model must be
  # saved first; afterwards it is opened again exactly as saved (see export_to).
  def export
    model = Sketchup.active_model
    base = model.path.empty? ? File.join(Dir.home, 'Desktop', "#{model.title.empty? ? 'Model' : model.title}.skp") : model.path
    look = nil
    ask = UI.messagebox("Use a look file from Model Viewer (your colours, Save › Save file for SketchUp)?\n\n" \
                        'Yes: pick the .mvlook.json file.   No: joints and flicker fix only.', MB_YESNOCANCEL)
    return if ask == IDCANCEL
    if ask == IDYES
      downloads = File.join(Dir.home, 'Downloads')
      file = UI.openpanel('Look file from Model Viewer', Dir.exist?(downloads) ? downloads : File.dirname(base),
                          'Model Viewer look|*.json||')
      return unless file
      begin
        look = JSON.parse(File.read(file, encoding: 'UTF-8'))
        raise 'not a Model Viewer look file' unless look['format'].to_s.start_with?('mv-look')
      rescue StandardError => e
        return UI.messagebox("That file could not be read (#{e.message}).")
      end
    end
    path = UI.savepanel('Save a clean copy (joint lines hidden, flicker fixed)', File.dirname(base),
                        "#{File.basename(base, '.*')}_clean.skp")
    return unless path
    path += '.skp' unless path.downcase.end_with?('.skp')
    if !model.path.empty? && File.expand_path(path).casecmp?(File.expand_path(model.path))
      return UI.messagebox("That is the open file itself. Pick another name, so your working model stays as it is.")
    end
    export_to(path, look)
  end

  # The copy is made from your saved model; afterwards your file is opened again exactly as saved (taking the
  # work back with Undo or an aborted operation is not reliable: SketchUp keeps the changes once a copy of a
  # model this size has been saved in the middle of them). Your camera view is kept.
  def export_to(path, look = nil)
    model = Sketchup.active_model
    orig = model.path
    if orig.empty? || model.modified?
      return UI.messagebox("Please save your model first (File › Save), then run Save a clean copy again.\n\n" \
                           'The clean copy is made from your saved file, and your file is opened again afterwards, ' \
                           'exactly as saved.')
    end
    cam = model.active_view.camera
    view = Sketchup::Camera.new(cam.eye, cam.target, cam.up, cam.perspective?, cam.fov)
    t0 = Time.now
    @export = true
    @faces = nil
    lines = more = sealed = hides = pushes = 0
    painted = nil
    saved = false
    begin
      model.start_operation('Clean copy', true)
      begin
        painted = apply_look(model, look) if look
        if look.nil? || look['joints'] != false
          lines, = run(dry: false)
          hides, pushes = flicker(dry: false) unless look && look['flicker'] == false
          @faces = nil
          more, sealed, = run(dry: false)
        end
        model.commit_operation
      rescue StandardError
        model.abort_operation
        raise
      end
      saved = model.save_copy(path)
    ensure
      @export = false
      @faces = nil
      reopen(model, orig, view)
    end
    secs = (Time.now - t0).round(1)
    return UI.messagebox("The copy could not be saved to #{path}.") unless saved
    text = "Saved a clean copy (#{secs} s):\n#{path}\n\n"
    if painted
      text += "Colours from Model Viewer: #{painted[:mats]} paints and #{painted[:objs]} objects changed"
      text += painted[:missed].empty? ? ".\n" : "; not found in this model: #{painted[:missed].first(6).join(', ')}" \
                                                 "#{painted[:missed].size > 6 ? '...' : ''}.\n"
    end
    text += "#{lines + more} joint lines hidden, #{sealed} hairline gaps sealed, #{hides} flickering faces hidden and " \
            "#{pushes} moved 1 mm forward.\n" if look.nil? || look['joints'] != false
    UI.messagebox(text + 'Your model is open again exactly as you saved it.')
  end

  # park the worked-on model in a temporary file (so opening yours does not ask to save it), open yours again
  def reopen(model, orig, view)
    tmp = File.join(Dir.tmpdir, "mv_clean_work_#{Process.pid}.skp")
    model.save(tmp)
    Sketchup.open_file(orig)
    Sketchup.active_model.active_view.camera = view
    [tmp, tmp.sub(/\.skp\z/, '.skb')].each { |f| File.delete(f) if File.exist?(f) }
  rescue StandardError => e
    UI.messagebox("Your model could not be opened again by itself (#{e.message}). Please open #{orig} again; " \
                  'do not save the open one over it.')
  end

  # The colours picked in Model Viewer: a paint recoloured everywhere it is used, or one object (and everything
  # inside it) in a colour of its own. Objects are found by SketchUp's persistent id, else by their path of names.
  def apply_look(model, look)
    res = { mats: 0, objs: 0, missed: [] }
    col = look['colours'] || {}
    (col['materials'] || []).each do |m|
      # by name; a .skp opened in the viewer has no paint names, so then by the original colour (the viewer
      # recolours every paint of that colour too)
      mats = m['name'].to_s.empty? ? [] : model.materials.select { |x| x.name == m['name'] || x.display_name == m['name'] }
      mats = model.materials.select { |x| x.texture.nil? && near?(x.color, m['was']) } if mats.empty? && m['was']
      next res[:missed] << (m['name'].to_s.empty? ? m['was'] : m['name']) if mats.empty?
      mats.each { |x| x.color = rgb(m['to']) }
      res[:mats] += mats.size
    end
    (col['objects'] || []).each do |o|
      found = []
      if o['pid'] && model.respond_to?(:find_entity_by_persistent_id)
        e = model.find_entity_by_persistent_id(o['pid'].to_i)
        found << e if e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
      end
      found = by_path(model.entities, o['path'] || []) if found.empty?
      next res[:missed] << (o['path'] || []).last.to_s if found.empty?
      paint = colour_material(model, o['to'])
      found.each { |inst| paint_inside(inst, paint) }
      res[:objs] += 1
    end
    res
  end

  # same colour give or take rounding (the viewer turns colours to linear and back)
  def near?(c, hex)
    h = hex.to_s.delete('#')
    return false unless h.size == 6
    [c.red, c.green, c.blue].zip(h.scan(/../).map { |x| x.to_i(16) }).all? { |a, b| (a - b).abs <= 2 }
  end

  def rgb(hex) = Sketchup::Color.new(*hex.to_s.delete('#').scan(/../).first(3).map { |x| x.to_i(16) })

  def colour_material(model, to)
    name = "MV #{to.downcase}"
    model.materials[name] || model.materials.add(name).tap { |m| m.color = rgb(to) }
  end

  # the groups / components along a path of names. A name with no group of its own in SketchUp is a level the
  # viewer added (ROOT, or "D1 GF" gathering the parts named "D1 GF ..."): it is stepped over.
  def by_path(ents, path)
    level = [ents]
    found = []
    path.each_with_index do |seg, i|
      hits = level.flat_map do |es|
        es.select { |e| (e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)) && label_of(e) == seg }
      end
      if i == path.size - 1 then found = hits
      elsif hits.any? then level = hits.map { |h| h.definition.entities }
      end
    end
    found
  end

  def label_of(e) = e.name.empty? ? e.definition.name : e.name

  # this copy only: its own definition, every face inside in the new paint
  def paint_inside(inst, paint)
    inst.make_unique if inst.definition.instances.size > 1
    inst.material = paint
    inst.definition.entities.each do |e|
      if e.is_a?(Sketchup::Face)
        e.material = paint
        e.back_material = paint if e.back_material
      elsif e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
        paint_inside(e, paint)
      end
    end
  end

  def restore
    model = Sketchup.active_model
    model.start_operation('Restore flush joints', true)
    lines = faces = 0
    model.definitions.each do |d|
      d.entities.each do |e|
        if e.is_a?(Sketchup::Edge) && e.get_attribute(ATTR, 'hidden')
          e.hidden = false
          e.delete_attribute(ATTR, 'hidden')
          lines += 1
        elsif e.is_a?(Sketchup::Face) && !(orig = e.get_attribute(ATTR, 'orig')).nil?
          e.material = orig.empty? ? nil : model.materials[orig]
          e.delete_attribute(ATTR, 'orig')           # the flicker fix keeps its own notes on the face
          faces += 1
        end
      end
    end
    model.entities.grep(Sketchup::Edge).each { |e| next unless e.get_attribute(ATTR, 'hidden'); e.hidden = false; e.delete_attribute(ATTR, 'hidden'); lines += 1 }
    seals = model.entities.grep(Sketchup::Group).select { |g| g.get_attribute(ATTR, 'seals') }
    seals.each(&:erase!)
    model.commit_operation
    UI.messagebox("Restored #{lines} lines and #{faces} colours#{seals.any? ? ', and removed the gap strips' : ''}.")
  end

  # ---------------------------------------------------------------------------------------------------------

  def run(dry:)
    model = Sketchup.active_model
    t0 = Time.now
    @faces = nil
    conts = []
    counts = Hash.new(0)
    collect(model.entities, Geom::Transformation.new, conts, counts)
    edges = []
    buckets = {}
    conts.each do |c|
      c[:defn].entities.grep(Sketchup::Edge).each do |e|
        next if (e.soft? || e.smooth?) && !corner?(e)
        # lines this script hid before still count as partners (a rerun must see both sides of a joint);
        # lines hidden by you are left alone
        done = e.hidden?
        next if done && !e.get_attribute(ATTR, 'hidden')
        r = edge_record(c, e)
        next unless r
        r[:done] = done
        edges << r
        (buckets[r[:key]] ||= []) << r
      end
    end

    hide_votes = Hash.new(0)        # [definition, edge] -> number of copies where the whole edge is a joint
    parts = {}                      # [definition, edge] -> joint stretches (one-copy parts only), from the edge's start
    paint = {}                      # [definition, face] -> [material, copies where it qualifies]
    @seals = []                     # strips closing hairline gaps at joints: [4 world points, material]
    edges.each do |er|
      ints = sweep(er, buckets, paint)
      next if er[:done]             # hidden on an earlier run: only its seals are made again
      ints += covered(er, conts) if span_of(ints) < er[:len] * 0.95
      ints = merge(ints)
      key = [er[:c][:defn], er[:e]]
      if span_of(ints) >= er[:len] * 0.95
        hide_votes[key] += 1
      elsif counts[er[:c][:defn]] == 1 && !ints.empty?
        # a long line that is a joint only in places (a beam's edge passing columns, walls and a window head):
        # the line is cut where that changes and only the joint pieces are hidden
        parts[key] = [er[:len], ints]
      end
    end

    to_hide = hide_votes.select { |(d, _), v| v >= counts[d] }.keys.map(&:last)
    to_split = parts.reject { |key, _| hide_votes[key] >= counts[key[0]] }.map { |(_, e), v| [e, *v] }
    to_paint = paint.select { |(d, _), (_, v)| v.size >= counts[d] }.map { |(_, f), (m, _)| [f, m] }
    # faces painted on an earlier run that no longer qualify get their own colour back
    keep = to_paint.map(&:first).to_set
    unpaint = conts.map { |c| c[:defn] }.uniq.flat_map do |d|
      d.entities.grep(Sketchup::Face).select { |f| !f.get_attribute(ATTR, 'orig').nil? && !keep.include?(f) }
    end
    secs = (Time.now - t0).round(1)
    if dry
      UI.messagebox("Preview (nothing changed):\n#{to_hide.size} joint lines would be hidden\n" \
                    "#{to_split.size} long lines would be hidden where they are a joint (cut there, rest stays)\n" \
                    "#{@seals.size} hairline gaps would be sealed\n" \
                    "#{to_paint.size} faces would take the wall's paint\n" \
                    "#{unpaint.size} faces painted earlier would get their own colour back\n" \
                    "#{conts.size} groups and components looked at in #{secs} s.\n\nRun MVJoints.apply to do it.")
      return
    end
    model.start_operation('Flush joints', true) unless @export
    pieces = 0
    begin
      to_hide.each do |e|
        next unless e.valid?
        e.hidden = true
        e.set_attribute(ATTR, 'hidden', true)
      end
      to_split.each { |e, len, ints| pieces += hide_pieces(e, len, ints) }
      sealed = build_seals(model)
      painted = 0
      to_paint.each do |f, m|
        next if f.material == m
        f.set_attribute(ATTR, 'orig', f.material ? f.material.name : '') if f.get_attribute(ATTR, 'orig').nil?
        f.material = m
        painted += 1
      end
      unpaint.each do |f|
        orig = f.get_attribute(ATTR, 'orig')
        f.material = orig.empty? ? nil : model.materials[orig]
        f.delete_attribute(ATTR, 'orig')
      end
      model.commit_operation unless @export
    rescue StandardError => e
      model.abort_operation unless @export
      raise e
    end
    return [to_hide.size + pieces, sealed, painted] if @export
    back = unpaint.empty? ? '' : " (#{unpaint.size} faces painted earlier got their own colour back)"
    UI.messagebox("Hid #{to_hide.size} joint lines, plus #{pieces} joint pieces of #{to_split.size} long lines, sealed " \
                  "#{sealed} hairline gaps, and gave #{painted} faces the wall's paint#{back} (#{secs} s).\n" \
                  "Edit > Undo takes it back; MVJoints.restore puts everything back later.\n" \
                  "View > Hidden Geometry shows the hidden lines again while it is on.")
  end

  # the strips go in one group of their own ("MV joint seals"), made afresh on each run; restore deletes it
  def build_seals(model)
    model.entities.grep(Sketchup::Group).each { |g| g.erase! if g.valid? && g.get_attribute(ATTR, 'seals') }
    return 0 if @seals.nil? || @seals.empty?
    g = model.entities.add_group
    g.name = 'MV joint seals'
    g.set_attribute(ATTR, 'seals', true)
    n = 0
    @seals.each do |pts, m|
      f = begin
        g.entities.add_face(pts.map { |p| Geom::Point3d.new(*p) })
      rescue ArgumentError
        nil
      end
      next unless f
      f.material = m
      f.back_material = m
      n += 1
    end
    g.entities.grep(Sketchup::Edge).each { |e| e.hidden = true }
    g.erase! if n.zero?
    n
  end

  def span_of(ints) = ints.sum { |lo, hi| hi - lo }

  # A soft edge where its part turns a corner (a wall panel's end) is still drawn as a profile line when the
  # style has Profiles on, so it counts like any other line. Soft edges across a curve or a flat face do not.
  def corner?(e)
    fs = e.faces
    fs.size < 2 || (fs[0].normal % fs[1].normal).abs < 0.87
  end

  # overlapping or touching stretches joined; pieces shorter than 1 cm dropped
  def merge(ints)
    out = []
    ints.sort_by(&:first).each do |lo, hi|
      if out.any? && lo <= out[-1][1] + 0.04 then out[-1][1] = [out[-1][1], hi].max
      else out << [lo, hi]
      end
    end
    out.select { |lo, hi| hi - lo >= 0.39 }
  end

  # cut edge e (length len in the world) at the ends of the joint stretches and hide the pieces inside them.
  # A point added on a straight edge changes no face; restore shows the pieces again.
  def hide_pieces(e, len, ints)
    return 0 unless e.valid?
    a = e.start.position
    b = e.end.position
    at = ->(l) { Geom::Point3d.linear_combination(1.0 - l / len, a, l / len, b) }
    cuts = ints.flatten.select { |l| l > 0.2 && l < len - 0.2 }.uniq.sort
    on = ->(p, pt) { (p.start.position.distance(pt) + pt.distance(p.end.position) - p.length).abs < 0.001 }
    pieces = [e]
    cuts.each do |l|
      pt = at.call(l)
      piece = pieces.find { |p| p.valid? && on.call(p, pt) && pt.distance(p.start.position) > 0.01 && pt.distance(p.end.position) > 0.01 }
      next unless piece
      added = piece.split(pt)
      pieces << added if added.is_a?(Sketchup::Edge)
    end
    hidden = 0
    pieces.each do |p|
      next unless p.valid?
      mid = (p.start.position.distance(a) + p.end.position.distance(a)) / 2.0 * len / a.distance(b)
      next unless ints.any? { |lo, hi| mid > lo && mid < hi }
      p.hidden = true
      p.set_attribute(ATTR, 'hidden', true)
      hidden += 1
    end
    hidden
  end

  # every visible group / component with its world transformation (nested ones too)
  def collect(ents, tr, out, counts, path = [])
    ents.each do |e|
      next unless e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
      next if e.hidden? || (e.layer && !e.layer.visible?)
      next if e.get_attribute(ATTR, 'seals')       # the script's own gap strips
      t = tr * e.transformation
      d = e.definition
      counts[d] += 1
      chain = path + [e]
      label = chain.map { |x| "#{x.name} #{x.layer && x.layer.name}" }.join(' ')
      own = "#{e.name} #{d.name}"
      wall = label.match?(WALL) && !own.match?(NOT_WALL)
      paint = !wall && label.match?(PAINT) && !own.match?(NO_PAINT)
      bb = d.bounds
      out << { inst: e, defn: d, tr: t, inv: t.inverse, wall: wall, paint: paint, centre: bb.center.transform(t), id: out.size } if d.entities.grep(Sketchup::Face).any?
      collect(d.entities, t, out, counts, chain)
    end
  end

  def v3(v) = [v.x.to_f, v.y.to_f, v.z.to_f]
  def dot(a, b) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  def sub(a, b) = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  def add(a, b, s = 1.0) = [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
  def norm(a)
    l = Math.sqrt(dot(a, a))
    l < 1e-12 ? nil : [a[0] / l, a[1] / l, a[2] / l]
  end

  # an edge in the world, with the direction each of its faces runs away from it
  def edge_record(c, e)
    tr = c[:tr]
    p0 = v3(e.start.position.transform(tr))
    p1 = v3(e.end.position.transform(tr))
    d = norm(sub(p1, p0))
    return nil unless d
    len = Math.sqrt(dot(sub(p1, p0), sub(p1, p0)))
    return nil if len < 0.04
    dirs = e.faces.map { |f| (a = away(f, e, tr, d)) ? [a, f] : nil }.compact
    return nil if dirs.empty?
    s = d.find { |x| x.abs > 1e-9 } || 1.0
    s = s.negative? ? -1.0 : 1.0
    foot = add(p0, d, -dot(p0, d))
    cell = 0.3937                                   # 1 cm
    key = [*d.map { |x| (x * s * 200).round }, *foot.map { |x| (x / cell).round }]
    { c: c, e: e, p0: p0, d: d, len: len, dirs: dirs, key: key }
  end

  # the way face f runs away from edge e (world, unit, square to the edge)
  def away(f, e, tr, d)
    ev = e.line[1]
    perp = f.normal * ev                            # cross product
    return nil if perp.length < 1e-9
    perp.normalize!
    mid = e.start.position.offset(ev, e.length / 2.0)
    inside = [Sketchup::Face::PointInside, Sketchup::Face::PointOnEdge, Sketchup::Face::PointOnVertex]
    probe = 0.04                                    # 1 mm
    unless inside.include?(f.classify_point(mid.offset(perp, probe)))
      perp.reverse!
      return nil unless inside.include?(f.classify_point(mid.offset(perp, probe)))
    end
    w = v3(perp.transform(tr))
    norm(add(w, d, -dot(w, d)))
  end

  NEIGH = [-1, 0, 1].product([-1, 0, 1], [-1, 0, 1]).freeze

  # joint stretches of edge er ([from, to] along it, world inches), noting faces that take the wall's paint
  def sweep(er, buckets, paint)
    spans = er[:dirs].each_with_index.map { |(a, f), i| [0.0, er[:len], a, er, i, f] }
    NEIGH.each do |dx, dy, dz|
      k = er[:key].dup
      k[3] += dx; k[4] += dy; k[5] += dz
      (buckets[k] || []).each do |fr|
        next if fr.equal?(er) || dot(fr[:d], er[:d]).abs < 1 - 1e-6
        q = sub(fr[:p0], er[:p0])
        off = add(q, er[:d], -dot(q, er[:d]))
        next if Math.sqrt(dot(off, off)) > TOL
        a = dot(q, er[:d])
        b = a + fr[:len] * dot(fr[:d], er[:d])
        lo = [0.0, [a, b].min].max
        hi = [er[:len], [a, b].max].min
        next if hi - lo <= 0.004
        fr[:dirs].each_with_index { |(dir, f), i| spans << [lo, hi, dir, fr, i, f] }
      end
    end
    return [] if spans.size < 3
    cuts = spans.flat_map { |s| [s[0], s[1]] }.uniq.sort
    found = []
    cuts.each_cons(2) do |lo, hi|
      next if hi - lo < 0.004
      mid = (lo + hi) / 2
      here = spans.select { |s| s[0] <= mid && s[1] >= mid }
      across = false
      ok = here.all? do |s|
        here.any? do |o|
          next false if o.equal?(s) || (o[3].equal?(s[3]) && o[4] == s[4])
          dd = dot(s[2], o[2])
          across = true if dd < -SAME
          dd < -SAME || (dd > SAME && !o[3].equal?(s[3]))
        end
      end
      next unless ok && across
      found << [lo, hi]
      # a hairline gap between this face and the one it runs on into: a strip in the wall's paint closes it
      here.each do |s|
        next unless s[3].equal?(er)
        here.each do |o|
          next if o[3].equal?(er) || dot(s[2], o[2]) > -SAME || o[3].object_id < er.object_id
          # where the other face's edge lies, across from this face; ahead of it (inside this face) they overlap
          off = dot(sub(o[3][:p0], er[:p0]), s[2])
          next if off > -0.02                               # touching (under half a millimetre) or overlapping
          w0 = off - 0.04                                   # 1 mm onto each side
          w1 = 0.04
          side = o[3][:c][:wall] ? o : s
          m = side[5].material || side[3][:c][:inst].material
          pts = [[lo, w0], [hi, w0], [hi, w1], [lo, w1]].map { |l, w| add(add(er[:p0], er[:d], l), s[2], w) }
          (@seals ||= []) << [pts, m]
        end
      end
      # this part's face carries on into a wall's face: it takes the wall's paint (columns, beams, slabs, panels)
      next unless er[:c][:paint]
      here.each do |s|
        next unless s[3].equal?(er)
        o = here.find { |x| x[3][:c][:wall] && dot(s[2], x[2]) < -SAME }
        next unless o
        m = o[5].material || o[3][:c][:inst].material
        next if m.nil?                              # already the wall's paint (an earlier run) still counts: it stays
        rec = (paint[[er[:c][:defn], s[5]]] ||= [m, Set.new])
        rec[1] << er[:c][:id] if rec[0] == m
      end
    end
    found
  end

  # an edge lying inside another part's face, its side running into that part's solid: a column beside a beam end
  # (stretches along the edge where that holds)
  def covered(er, conts)
    @faces ||= index_faces(conts)
    found = []
    # a line with a face on one side only (a panel whose end is open where it meets a column): it is a joint
    # wherever the surface simply carries on past it in the same plane
    er[:dirs].first(2).each_with_index do |(f, _), i|
      s = er[:dirs].size >= 2 ? er[:dirs][1 - i][0] : nil
      n = norm([f[1] * er[:d][2] - f[2] * er[:d][1], f[2] * er[:d][0] - f[0] * er[:d][2], f[0] * er[:d][1] - f[1] * er[:d][0]])
      next unless n
      steps = [[(er[:len] / 4.0).ceil, 2].max, 40].min    # about every 10 cm, at most 40
      step = er[:len] / steps
      ok = lambda do |k|
        on = add(er[:p0], er[:d], step * (k + 0.5))
        pt = add(on, f, -0.04)
        # the surface may carry on in the same group too (a gable panel made of several pieces)
        other = covering(pt, n, er[:c], allow_own: true)
        next false unless other
        next true unless s
        if other.equal?(er[:c])
          side = dot(sub(other[:centre].to_a, pt), n)
          next (side.positive? && dot(s, n).positive?) || (side.negative? && dot(s, n).negative?)
        end
        # the part's other face must run into the other part's body (a column's side inside the beam), not along
        # its outside (the corner of the house, where the column face only lies over a wall's face)
        q = Geom::Point3d.new(*add(on, s, 0.5)).transform(other[:inv])
        bb = other[:defn].bounds
        m = 0.04
        q.x > bb.min.x + m && q.x < bb.max.x - m && q.y > bb.min.y + m && q.y < bb.max.y - m &&
          q.z > bb.min.z + m && q.z < bb.max.z - m
      end
      # every step: a beam's long edge is covered only where it passes the columns, anywhere along it
      steps.times { |k| found << [step * k, step * (k + 1)] if ok.call(k) }
    end
    found
  end

  CELL = 39.37                      # 1 m grid, so a lookup only meets the faces near the point

  def index_faces(conts)
    idx = {}
    conts.each do |c|
      c[:defn].entities.grep(Sketchup::Face).each do |f|
        n = norm(v3(f.normal.transform(c[:tr])))
        next unless n
        o = dot(n, v3(f.vertices[0].position.transform(c[:tr])))
        pk = plane_key(n, o)
        pts = f.vertices.map { |vx| v3(vx.position.transform(c[:tr])) }
        lo = (0..2).map { |k| (pts.map { |p| p[k] }.min / CELL).floor }
        hi = (0..2).map { |k| (pts.map { |p| p[k] }.max / CELL).floor }
        next if (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 2000
        (lo[0]..hi[0]).each do |x|
          (lo[1]..hi[1]).each do |y|
            (lo[2]..hi[2]).each { |z| (idx[[*pk, x, y, z]] ||= []) << [c, f] }
          end
        end
      end
    end
    idx
  end

  def plane_key(n, o)
    s = n.find { |x| x.abs > 1e-9 } || 1.0
    s = s.negative? ? -1.0 : 1.0
    [*n.map { |x| (x * s * 100).round }, (o * s / 0.2).round]
  end

  def covering(pt, n, own, allow_own: false)
    s = n.find { |x| x.abs > 1e-9 } || 1.0
    s = s.negative? ? -1.0 : 1.0
    base = n.map { |x| (x * s * 100).round }
    o = (dot(n, pt) * s / 0.2).round
    cell = pt.map { |x| (x / CELL).floor }
    (-3..3).each do |k|
      (@faces[[*base, o + k, *cell]] || []).each do |c, f|
        next if c.equal?(own) && !allow_own
        lp = Geom::Point3d.new(*pt).transform(c[:inv])
        next unless (f.plane[0] * lp.x + f.plane[1] * lp.y + f.plane[2] * lp.z + f.plane[3]).abs < TOL
        # up to 15 mm off the face (a face the flicker fix moved 1 mm forward): classify its foot on the face
        r = f.classify_point(lp.project_to_plane(f.plane))
        return c if [Sketchup::Face::PointInside, Sketchup::Face::PointOnEdge].include?(r)
      end
    end
    nil
  end
end

MVJoints.instance_variable_set(:@faces, nil)
unless file_loaded?(__FILE__)
  menu = UI.menu('Extensions').add_submenu('Flush joints')
  menu.add_item('Preview (count only)') { MVJoints.instance_variable_set(:@faces, nil); MVJoints.preview }
  menu.add_item('Hide joints and paint flush parts') { MVJoints.instance_variable_set(:@faces, nil); MVJoints.apply }
  menu.add_item('Restore lines and colours') { MVJoints.restore }
  menu.add_separator
  menu.add_item('Flicker: preview (count only)') { MVJoints.flicker_preview }
  menu.add_item('Flicker: fix overlapping faces') { MVJoints.flicker_apply }
  menu.add_item('Flicker: restore') { MVJoints.flicker_restore }
  menu.add_separator
  menu.add_item('Save a clean copy...') { MVJoints.export }
  file_loaded(__FILE__)
end
