// Building-element categories, guessed from each object's name and tag.
// First match wins. Services and fittings come first because their names often mention the
// element they run through ("drain under slab", "pipe box over D4: W1 main"). Edit freely.
export const CATEGORIES = [
  ['Finishes', /wall tile|floor tile|tiling|skirting|plaster|\brender\b|paint|ceiling|cladding|screed|floor finish/i],
  ['Sanitary', /\bwc\b|toilet|basin|\bsink\b|shower|bath ?tub|\btap\b|mixer|urinal|bidet|floor drain|grease trap/i],
  ['Plumbing', /pipe|drain|waste|water|tank|valve|\btrap\b|riser|\bvent\b|sewer|septic|soak|manhole|chamber|pump|\bwell\b|gully|elbow|\btee\b|reducer|fitting|plumb/i],
  ['HVAC', /\bac\s?\d|\bcu\s?\d|condens|duct|\bfan\b|outdoor unit|indoor unit|split unit|air.?con|compressor|refrigerant/i],
  ['Solar', /\bpv\b|solar|inverter|battery/i],
  ['Electrical', /cable|conduit|socket|switch|\blight|\blamp|\bled\b|\bdb\b|db-|distribution board|wiring|earth rod|meter|breaker|luminaire/i],
  ['Furniture', /sofa|\bbed\b|table|chair|cabinet|wardrobe|shel(f|ves)|desk|counter|kitchen|furniture|bench|stool|drawer|mirror|\btv\b|rug|curtain|fridge|cooker|hood|\bcar\b/i],
  ['Doors', /\bdoor/i],
  ['Windows', /window|glazing|glass|louv(re|er)|jalousie/i],
  ['Railings', /rail|balustr|baluster|handrail|grille/i],
  ['Stairs', /stair|\bstep|tread|landing|nosing|stringer/i],
  ['Foundations', /footing|foundation|\bpile|blinding|lean concrete|excavat|pedestal|short column|stub column/i],
  ['Columns', /column|\bcol\b|pillar|\bpost\b/i],
  ['Beams', /beam|lintel|plinth|\btie\b/i],
  ['Slabs', /slab|\bdeck\b|topping/i],
  ['Walls', /wall|parapet|partition|brick|block|masonry/i],
  ['Roof', /roof|purlin|truss|rafter|gutter|ridge|fascia|flashing|downpipe|\bsheet/i],
  ['Site', /site|paving|\bpave|fence|gate|boundary|garden|grass|ground|soil|terrain|drive|kerb|curb|tree|plant|road|lawn|backfill|\bfill\b|sand|hardcore|context|neighbo|verge/i],
];

export const OTHER = 'Other';

// the name decides; the tag only when the name says nothing
export function categorize(name, tag) {
  for (const [cat, re] of CATEGORIES) if (re.test(name || '')) return cat;
  for (const [cat, re] of CATEGORIES) if (re.test(tag || '')) return cat;
  return OTHER;
}
