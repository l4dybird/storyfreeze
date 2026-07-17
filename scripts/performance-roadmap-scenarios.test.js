const assert = require('node:assert/strict');
const test = require('node:test');
const { scenarios, selectScenarios } = require('./performance-roadmap-scenarios.js');

test('defines every required roadmap benchmark workload', () => {
  assert.deepEqual(
    Object.values(scenarios).map(scenario => scenario.label),
    [
      '1 Story / 1 PNG',
      'Many stories / 1 PNG each',
      'Few stories / many variants',
      'Multiple viewports',
      'Mixed mobile / desktop',
      'Large fullPage',
      'High-DPR',
      'Network-heavy',
      'Interaction-heavy',
    ],
  );
  for (const scenario of Object.values(scenarios)) {
    assert.ok(scenario.expectedStories > 0);
    assert.ok(scenario.expectedPngs >= scenario.expectedStories);
    assert.match(scenario.include, /^Performance\/Matrix\//);
  }
  assert.equal(scenarios.manyStories.include, 'Performance/Matrix/Many *');
});

test('selects all scenarios deterministically or an explicit subset', () => {
  assert.deepEqual(
    selectScenarios('variantHeavy,single').map(([name]) => name),
    ['variantHeavy', 'single'],
  );
  assert.deepEqual(
    selectScenarios().map(([name]) => name),
    Object.keys(scenarios),
  );
  assert.throws(() => selectScenarios('missing'), /Unknown performance scenario/);
});
