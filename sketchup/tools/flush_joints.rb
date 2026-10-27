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
#     MVJoints.flicker_preview / MVJoints.flicker_apply / MVJoints.flicker_restore
#                          # flickering faces: where a smaller part's face overlaps a bigger part's face in the same
#                          # plane, it is hidden (fully covered, same paint) or moved 1 mm forward (one Undo step;
#                          # restore puts them back). Run it after MVJoints.apply, so flush posts already wear the
#                          # wall's paint and simply disappear into the wall.
# Loading also adds Extensions > Flush joints with the same commands.
#
# How a joint is found: along each edge line, every face that touches it (any group or component) is looked at.
# A stretch is a joint when the faces there carry on across the line in one plane, and the rest lie back to back.
# Parts may be up to 15 mm apart. An edge lying inside another part's face (a column passing a beam end) also goes
# when its side runs into the solid. A component's edge is hidden only if that is true for every copy of it.
require 'set'

module MVJoints
  ATTR = 'mv_joints'
  TOL = 15.mm                       # SketchUp lengths are inches; 15 mm
  SAME = 0.999
  # parts whose paint spreads to flush columns, beams and slab edges (name or tag); edit to suit your naming
  WALL = /wall|plaster|parapet|partition/i
  NOT_WALL = /tile|skirting|frame|window|door|sill|coping|footing/i

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
    model.start_operation('Flicker fix', true)
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
      model.commit_operation
    rescue StandardError => e
      model.abort_operation
      raise e
    end
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

  def preview
    run(dry: true)
  end

  def apply
    run(dry: false)
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
    model.commit_operation
    UI.messagebox("Restored #{lines} lines and #{faces} colours.")
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
        next if e.hidden? || e.soft? || e.smooth?
        r = edge_record(c, e)
        next unless r
        edges << r
        (buckets[r[:key]] ||= []) << r
      end
    end

    hide_votes = Hash.new(0)        # [definition, edge] -> number of copies where it is a joint
    paint = {}                      # [definition, face] -> [material, copies where it qualifies]
    edges.each do |er|
      cut = sweep(er, buckets, paint)
      cut += covered(er, conts) if cut < er[:len] * 0.95
      hide_votes[[er[:c][:defn], er[:e]]] += 1 if cut >= er[:len] * 0.95
    end

    to_hide = hide_votes.select { |(d, _), v| v >= counts[d] }.keys.map(&:last)
    to_paint = paint.select { |(d, _), (_, v)| v.size >= counts[d] }.map { |(_, f), (m, _)| [f, m] }
    secs = (Time.now - t0).round(1)
    if dry
      UI.messagebox("Preview (nothing changed):\n#{to_hide.size} joint lines would be hidden\n#{to_paint.size} faces would take the wall's paint\n" \
                    "#{conts.size} groups and components looked at in #{secs} s.\n\nRun MVJoints.apply to do it.")
      return
    end
    model.start_operation('Flush joints', true)
    begin
      to_hide.each do |e|
        e.hidden = true
        e.set_attribute(ATTR, 'hidden', true)
      end
      to_paint.each do |f, m|
        f.set_attribute(ATTR, 'orig', f.material ? f.material.name : '') if f.get_attribute(ATTR, 'orig').nil?
        f.material = m
      end
      model.commit_operation
    rescue StandardError => e
      model.abort_operation
      raise e
    end
    UI.messagebox("Hid #{to_hide.size} joint lines and gave #{to_paint.size} faces the wall's paint (#{secs} s).\n" \
                  "Edit > Undo takes it back; MVJoints.restore puts everything back later.\n" \
                  "View > Hidden Geometry shows the hidden lines again while it is on.")
  end

  # every visible group / component with its world transformation (nested ones too)
  def collect(ents, tr, out, counts, path = [])
    ents.each do |e|
      next unless e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
      next if e.hidden? || (e.layer && !e.layer.visible?)
      t = tr * e.transformation
      d = e.definition
      counts[d] += 1
      chain = path + [e]
      label = chain.map { |x| "#{x.name} #{x.layer && x.layer.name}" }.join(' ')
      wall = label.match?(WALL) && !"#{e.name} #{d.name}".match?(NOT_WALL)
      bb = d.bounds
      out << { inst: e, defn: d, tr: t, inv: t.inverse, wall: wall, centre: bb.center.transform(t), id: out.size } if d.entities.grep(Sketchup::Face).any?
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

  # joint stretches of edge er (returns the length covered), noting faces that take the wall's paint
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
    return 0.0 if spans.size < 3
    cuts = spans.flat_map { |s| [s[0], s[1]] }.uniq.sort
    total = 0.0
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
      total += hi - lo
      # this part's face carries on into a wall's face: it takes the wall's paint
      next if er[:c][:wall]
      here.each do |s|
        next unless s[3].equal?(er)
        o = here.find { |x| x[3][:c][:wall] && dot(s[2], x[2]) < -SAME }
        next unless o
        m = o[5].material || o[3][:c][:inst].material
        next if m.nil? || m == s[5].material
        rec = (paint[[er[:c][:defn], s[5]]] ||= [m, Set.new])
        rec[1] << er[:c][:id] if rec[0] == m
      end
    end
    total
  end

  # an edge lying inside another part's face, its side running into that part's solid: a column beside a beam end
  def covered(er, conts)
    @faces ||= index_faces(conts)
    return 0.0 if er[:dirs].size < 2
    covered_len = 0.0
    er[:dirs].each_with_index do |(f, _), i|
      s = er[:dirs][1 - i][0]
      n = norm([f[1] * er[:d][2] - f[2] * er[:d][1], f[2] * er[:d][0] - f[0] * er[:d][2], f[0] * er[:d][1] - f[1] * er[:d][0]])
      next unless n
      steps = [[(er[:len] / 2.0).ceil, 2].max, 12].min
      hit = 0
      steps.times do |k|
        at = add(er[:p0], er[:d], er[:len] * (k + 0.5) / steps)
        pt = add(at, f, -0.04)
        other = covering(pt, n, er[:c])
        break unless other
        side = dot(sub(other[:centre].to_a, pt), n)
        break unless (side.positive? && dot(s, n).positive?) || (side.negative? && dot(s, n).negative?)
        hit += 1
      end
      covered_len = er[:len] if hit == steps
    end
    covered_len
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

  def covering(pt, n, own)
    s = n.find { |x| x.abs > 1e-9 } || 1.0
    s = s.negative? ? -1.0 : 1.0
    base = n.map { |x| (x * s * 100).round }
    o = (dot(n, pt) * s / 0.2).round
    cell = pt.map { |x| (x / CELL).floor }
    (-3..3).each do |k|
      (@faces[[*base, o + k, *cell]] || []).each do |c, f|
        next if c.equal?(own)
        lp = Geom::Point3d.new(*pt).transform(c[:inv])
        next unless (f.plane[0] * lp.x + f.plane[1] * lp.y + f.plane[2] * lp.z + f.plane[3]).abs < TOL
        r = f.classify_point(lp)
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
  file_loaded(__FILE__)
end
