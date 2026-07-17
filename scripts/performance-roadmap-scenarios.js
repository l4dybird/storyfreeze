const scenarios = Object.freeze({
  single: Object.freeze({
    label: '1 Story / 1 PNG',
    include: 'Performance/Matrix/Single/**',
    expectedStories: 1,
    expectedPngs: 1,
  }),
  manyStories: Object.freeze({
    label: 'Many stories / 1 PNG each',
    // Storybook 10 normalizes explicit names such as "Many/01" to "Many 01" in index.json.
    include: 'Performance/Matrix/Many *',
    expectedStories: 24,
    expectedPngs: 24,
  }),
  variantHeavy: Object.freeze({
    label: 'Few stories / many variants',
    include: 'Performance/Matrix/Variant Heavy/**',
    expectedStories: 1,
    expectedPngs: 13,
  }),
  multipleViewports: Object.freeze({
    label: 'Multiple viewports',
    include: 'Performance/Matrix/Multiple Viewports/**',
    expectedStories: 1,
    expectedPngs: 4,
  }),
  mixedDevices: Object.freeze({
    label: 'Mixed mobile / desktop',
    include: 'Performance/Matrix/Mixed Devices/**',
    expectedStories: 1,
    expectedPngs: 4,
  }),
  largeFullPage: Object.freeze({
    label: 'Large fullPage',
    include: 'Performance/Matrix/Large Full Page/**',
    expectedStories: 1,
    expectedPngs: 1,
  }),
  highDpr: Object.freeze({
    label: 'High-DPR',
    include: 'Performance/Matrix/High DPR/**',
    expectedStories: 1,
    expectedPngs: 3,
  }),
  networkHeavy: Object.freeze({
    label: 'Network-heavy',
    include: 'Performance/Matrix/Network Heavy/**',
    expectedStories: 1,
    expectedPngs: 1,
  }),
  interactionHeavy: Object.freeze({
    label: 'Interaction-heavy',
    include: 'Performance/Matrix/Interaction Heavy/**',
    expectedStories: 1,
    expectedPngs: 9,
  }),
});

function selectScenarios(value = 'all') {
  if (value === 'all') return Object.entries(scenarios);
  const names = value
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  if (!names.length) throw new Error('At least one performance scenario is required.');
  const unknown = names.filter(name => !Object.hasOwn(scenarios, name));
  if (unknown.length) throw new Error(`Unknown performance scenario(s): ${unknown.join(', ')}`);
  return names.map(name => [name, scenarios[name]]);
}

module.exports = { scenarios, selectScenarios };
