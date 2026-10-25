// Building-element categories, guessed from each object's name and tag.
// First match wins, so specific rules sit above general ones. Edit freely.
export const CATEGORIES = [
  ['Finishes', /wall tile|floor tile|tiling|skirting|plaster|render\b|paint|ceiling|cladding|screed/i],
  ['Doors', /\bdoor|\bD\d+\b/i],
  ['Windows', /window|glazing|glass|\bW\d+\b|louv(re|er)|vent block|jalousie/i],
  ['Railings', /rail|balustr|baluster|handrail|grille/i],
  ['Stairs', /stair|step|tread|landing|nosing|stringer/i],
  ['Foundations', /footing|foundation|pile|blinding|excavat|pit\b|pedestal|short column|stub/i],
  ['Columns', /column|\bcol\b|pillar|\bpost\b/i],
  ['Beams', /beam|lintel|plinth|tie\b|bond beam/i],
  ['Slabs', /slab|floor|deck|topping/i],
  ['Walls', /wall|parapet|partition|brick|block|masonry|a-wall/i],
  ['Roof', /roof|purlin|truss|rafter|gutter|ridge|fascia|flashing|downpipe|sheet/i],
  ['Furniture', /sofa|\bbed\b|table|chair|cabinet|wardrobe|shelf|shelves|desk|counter|kitchen|furniture|bench|stool|drawer|mirror|tv\b|rug|curtain|fridge|cooker|hood/i],
  ['Sanitary', /\bwc\b|toilet|basin|sink|shower|bath|\btap\b|mixer|urinal|bidet|floor drain/i],
  ['HVAC', /\bac\s?\d|\bcu\s?\d|condens|duct|\bfan\b|outdoor unit|indoor unit|split|air.?con|compressor/i],
  ['Plumbing', /pipe|drain|waste|water|tank|valve|trap|riser|vent|sewer|septic|soak|manhole|chamber|pump|well\b|gully|elbow|tee\b|reducer|fitting/i],
  ['Electrical', /cable|conduit|socket|switch|light|lamp|\bdb\b|db-|panel|solar|inverter|battery|wiring|earth|meter|breaker|luminaire/i],
  ['Site', /site|paving|pave|fence|gate|boundary|garden|grass|ground|soil|terrain|drive|kerb|curb|\bcar\b|tree|plant|road|lawn|backfill|fill\b|sand|context|neighbo/i],
];

export const OTHER = 'Other';

export function categorize(name, tag) {
  const text = `${name || ''} | ${tag || ''}`;
  for (const [cat, re] of CATEGORIES) if (re.test(text)) return cat;
  return OTHER;
}
