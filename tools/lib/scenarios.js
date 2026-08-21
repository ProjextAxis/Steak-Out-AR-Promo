/*
 * scenarios.js — the HELD-OUT test set.
 *
 * These describe camera frames the tracker is asked to acquire. Every
 * parameter here is deliberately DIFFERENT from the values used to build the
 * compiled variants in make-variants.js: different contrast endpoints,
 * different gammas, different angles, different glare placement, and blur
 * applied in a different domain (frame pixels after projection, rather than
 * artwork pixels before it). Testing a target on the exact image it was
 * compiled from would prove nothing.
 *
 * `heightFrac` is the flyer's height as a fraction of the 480px frame height,
 * so it stands in for distance: 0.95 is the flyer held close and filling the
 * view, 0.40 is it lying on a table an arm's length away.
 */

const SCENARIOS = [
  {
    name: 's01-close-flat-good-light',
    note: 'Held close, square on, decent light. The easy case.',
    heightFrac: 0.95, pitch: 0, yaw: 0, roll: 0, seed: 101,
    photometric: [{ op: 'contrast', args: { black: 30, white: 225 } }],
    optical: [{ op: 'noise', args: { sigma: 2, seed: 901 } }]
  },
  {
    name: 's02-close-tilted',
    note: 'Close but tilted 15 deg back and 10 deg round.',
    heightFrac: 0.90, pitch: 15, yaw: 10, roll: 0, seed: 102,
    photometric: [{ op: 'contrast', args: { black: 44, white: 210 } }],
    optical: [{ op: 'noise', args: { sigma: 2, seed: 902 } }]
  },
  {
    name: 's03-mid-flat-dim',
    note: 'Arm-ish length, square on, dim restaurant light.',
    heightFrac: 0.70, pitch: 0, yaw: 0, roll: 0, seed: 103,
    photometric: [
      { op: 'contrast', args: { black: 70, white: 185 } },
      { op: 'gamma', args: 1.2 }
    ],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 903 } }]
  },
  {
    name: 's04-mid-tilted-dim',
    note: 'Arm-ish length, 22 deg back / 16 deg round, dim.',
    heightFrac: 0.68, pitch: 22, yaw: 16, roll: 0, seed: 104,
    photometric: [
      { op: 'contrast', args: { black: 68, white: 188 } },
      { op: 'gamma', args: 1.15 }
    ],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 904 } }]
  },
  {
    name: 's05-far-flat',
    note: 'On the table, square on, flyer only 45% of frame height.',
    heightFrac: 0.45, pitch: 0, yaw: 0, roll: 0, seed: 105,
    photometric: [{ op: 'contrast', args: { black: 52, white: 198 } }],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 905 } }]
  },
  {
    name: 's06-far-tilted',
    note: 'On the table, viewed from a seat: 30 deg back, 8 deg round.',
    heightFrac: 0.48, pitch: 30, yaw: 8, roll: 0, seed: 106,
    photometric: [{ op: 'contrast', args: { black: 55, white: 196 } }],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 906 } }]
  },
  {
    name: 's07-motion-blur',
    note: 'Mid distance while the hand is moving: 1.6px frame-domain smear.',
    heightFrac: 0.75, pitch: 8, yaw: 6, roll: 0, seed: 107,
    photometric: [{ op: 'contrast', args: { black: 50, white: 200 } }],
    optical: [
      { op: 'blur', args: 1.6 },
      { op: 'noise', args: { sigma: 3, seed: 907 } }
    ]
  },
  {
    name: 's08-heavy-motion-blur',
    note: 'The drop case the user complains about: 2.8px smear mid-move.',
    heightFrac: 0.80, pitch: 10, yaw: 8, roll: 0, seed: 108,
    photometric: [{ op: 'contrast', args: { black: 50, white: 200 } }],
    optical: [
      { op: 'blur', args: 2.8 },
      { op: 'noise', args: { sigma: 3, seed: 908 } }
    ]
  },
  {
    name: 's09-glare-overhead',
    note: 'Ceiling downlight blowing out the right side of the sheet.',
    heightFrac: 0.85, pitch: 6, yaw: -8, roll: 0, seed: 109,
    photometric: [
      { op: 'contrast', args: { black: 48, white: 202 } },
      { op: 'glare', args: { cx: 0.66, cy: 0.42, radius: 0.38, strength: 120, aspect: 1.3 } }
    ],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 909 } }]
  },
  {
    name: 's10-glare-plus-blur',
    note: 'Glare and defocus together, the realistic worst case.',
    heightFrac: 0.72, pitch: 12, yaw: -10, roll: 0, seed: 110,
    photometric: [
      { op: 'contrast', args: { black: 58, white: 194 } },
      { op: 'glare', args: { cx: 0.6, cy: 0.35, radius: 0.42, strength: 110, aspect: 1.4 } }
    ],
    optical: [
      { op: 'blur', args: 1.9 },
      { op: 'noise', args: { sigma: 4, seed: 910 } }
    ]
  },
  {
    name: 's11-rolled',
    note: 'Flyer rotated 22 deg in the plane of the image.',
    heightFrac: 0.72, pitch: 5, yaw: 5, roll: 22, seed: 111,
    photometric: [{ op: 'contrast', args: { black: 46, white: 206 } }],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 911 } }]
  },
  {
    name: 's12-offcentre',
    note: 'Marker pushed to the edge of the frame, where the crop window has to find it.',
    heightFrac: 0.62, pitch: 8, yaw: 12, roll: -8, offsetX: 0.35, offsetY: -0.12, seed: 112,
    photometric: [{ op: 'contrast', args: { black: 50, white: 200 } }],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 912 } }]
  },
  {
    name: 's13-washed-out',
    note: 'Overexposed: gamma 0.78 on top of already-compressed print contrast.',
    heightFrac: 0.78, pitch: 5, yaw: 5, roll: 0, seed: 113,
    photometric: [
      { op: 'contrast', args: { black: 60, white: 200 } },
      { op: 'gamma', args: 0.78 }
    ],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 913 } }]
  },
  {
    name: 's14-steep-angle',
    note: 'Very oblique: 38 deg back, 20 deg round. Near the limit of planar tracking.',
    heightFrac: 0.75, pitch: 38, yaw: 20, roll: 0, seed: 114,
    photometric: [{ op: 'contrast', args: { black: 52, white: 198 } }],
    optical: [{ op: 'noise', args: { sigma: 3, seed: 914 } }]
  },
  {
    name: 's15-dim-blur-far',
    note: 'Everything wrong at once: far, dim, defocused, noisy.',
    heightFrac: 0.50, pitch: 18, yaw: 12, roll: 6, seed: 115,
    photometric: [
      { op: 'contrast', args: { black: 72, white: 182 } },
      { op: 'gamma', args: 1.1 }
    ],
    optical: [
      { op: 'blur', args: 1.7 },
      { op: 'noise', args: { sigma: 5, seed: 915 } }
    ]
  }
];

/*
 * The set above turns out to sit at the ceiling for a target compiled from good
 * artwork — nearly everything acquires and nothing drops. A benchmark pinned at
 * 100% cannot rank candidates, so this second tier pushes past the cliff:
 * further away, dimmer, blurrier, more oblique, with glare over the middle of
 * the sheet rather than its edge. These are deliberately beyond what a
 * cooperative user would do, and exist to find where each target breaks rather
 * than to represent typical use.
 */
const SCENARIOS_HARD = [
  {
    name: 'h01-very-far',
    note: 'Flyer only 28% of frame height — across a table.',
    heightFrac: 0.28, pitch: 0, yaw: 0, roll: 0, seed: 201,
    photometric: [{ op: 'contrast', args: { black: 55, white: 195 } }],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 801 } }]
  },
  {
    name: 'h02-very-far-tilted',
    note: '28% of frame, 35 deg back, 20 deg round.',
    heightFrac: 0.28, pitch: 35, yaw: 20, roll: 0, seed: 202,
    photometric: [{ op: 'contrast', args: { black: 58, white: 192 } }],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 802 } }]
  },
  {
    name: 'h03-flat-grey',
    note: 'Contrast crushed to 95..160 — a badly lit photocopy.',
    heightFrac: 0.70, pitch: 6, yaw: 6, roll: 0, seed: 203,
    photometric: [{ op: 'contrast', args: { black: 95, white: 160 } }],
    optical: [{ op: 'noise', args: { sigma: 5, seed: 803 } }]
  },
  {
    name: 'h04-flat-grey-far',
    note: 'Crushed contrast AND distance: 95..160 at 38% of frame.',
    heightFrac: 0.38, pitch: 10, yaw: 8, roll: 0, seed: 204,
    photometric: [{ op: 'contrast', args: { black: 95, white: 160 } }],
    optical: [{ op: 'noise', args: { sigma: 5, seed: 804 } }]
  },
  {
    name: 'h05-severe-blur',
    note: '4.5px frame-domain smear — a proper swing of the arm.',
    heightFrac: 0.78, pitch: 8, yaw: 6, roll: 0, seed: 205,
    photometric: [{ op: 'contrast', args: { black: 55, white: 198 } }],
    optical: [{ op: 'blur', args: 4.5 }, { op: 'noise', args: { sigma: 4, seed: 805 } }]
  },
  {
    name: 'h06-severe-blur-far',
    note: '3.5px smear at 42% of frame height.',
    heightFrac: 0.42, pitch: 12, yaw: 10, roll: 0, seed: 206,
    photometric: [{ op: 'contrast', args: { black: 60, white: 192 } }],
    optical: [{ op: 'blur', args: 3.5 }, { op: 'noise', args: { sigma: 4, seed: 806 } }]
  },
  {
    name: 'h07-extreme-angle',
    note: '52 deg back, 28 deg round — nearly edge-on.',
    heightFrac: 0.80, pitch: 52, yaw: 28, roll: 0, seed: 207,
    photometric: [{ op: 'contrast', args: { black: 55, white: 196 } }],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 807 } }]
  },
  {
    name: 'h08-centre-glare',
    note: 'Reflection sitting over the middle of the sheet, wiping out the QR block.',
    heightFrac: 0.80, pitch: 5, yaw: 5, roll: 0, seed: 208,
    photometric: [
      { op: 'contrast', args: { black: 62, white: 190 } },
      { op: 'glare', args: { cx: 0.5, cy: 0.5, radius: 0.5, strength: 150, aspect: 1.1 } }
    ],
    optical: [{ op: 'noise', args: { sigma: 4, seed: 808 } }]
  },
  {
    name: 'h09-glare-blur-dim',
    note: 'Centre glare, 2.8px smear, crushed contrast, all at once.',
    heightFrac: 0.62, pitch: 15, yaw: 12, roll: 8, seed: 209,
    photometric: [
      { op: 'contrast', args: { black: 88, white: 168 } },
      { op: 'glare', args: { cx: 0.45, cy: 0.45, radius: 0.45, strength: 130, aspect: 1.2 } }
    ],
    optical: [{ op: 'blur', args: 2.8 }, { op: 'noise', args: { sigma: 6, seed: 809 } }]
  },
  {
    name: 'h10-tiny-and-dim',
    note: '24% of frame height, crushed contrast, heavy sensor noise.',
    heightFrac: 0.24, pitch: 8, yaw: 8, roll: 4, seed: 210,
    photometric: [{ op: 'contrast', args: { black: 90, white: 165 } }],
    optical: [{ op: 'noise', args: { sigma: 6, seed: 810 } }]
  },
  {
    name: 'h11-far-blur-angle',
    note: '35% of frame, 30 deg back, 2.5px smear, dim.',
    heightFrac: 0.35, pitch: 30, yaw: 15, roll: 0, seed: 211,
    photometric: [{ op: 'contrast', args: { black: 80, white: 175 } }],
    optical: [{ op: 'blur', args: 2.5 }, { op: 'noise', args: { sigma: 5, seed: 811 } }]
  },
  {
    name: 'h12-washed-and-blurred',
    note: 'Overexposed to gamma 0.6 on crushed contrast, plus 2px smear.',
    heightFrac: 0.72, pitch: 10, yaw: 8, roll: 0, seed: 212,
    photometric: [
      { op: 'contrast', args: { black: 78, white: 198 } },
      { op: 'gamma', args: 0.6 }
    ],
    optical: [{ op: 'blur', args: 2.0 }, { op: 'noise', args: { sigma: 4, seed: 812 } }]
  }
];

const SETS = { normal: SCENARIOS, hard: SCENARIOS_HARD, all: [...SCENARIOS, ...SCENARIOS_HARD] };

/** Pick a set by name for the --set flag. */
function selectSet(name) {
  const set = SETS[name || 'normal'];
  if (!set) throw new Error(`unknown scenario set "${name}" (have: ${Object.keys(SETS).join(', ')})`);
  return set;
}

module.exports = { SCENARIOS, SCENARIOS_HARD, SETS, selectSet };
