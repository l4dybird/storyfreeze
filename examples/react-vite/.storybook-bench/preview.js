// Intentionally free of project-level `screenshot` parameters. Each bench
// scenario declares its own viewport/variant shape so scenarios stay isolated.
// Importing the workspace preview explicitly mirrors the addon's package
// convention without requiring the fixture to install or link StoryFreeze.
export { default } from '../../../packages/storyfreeze/dist/storybook/preview.js';
