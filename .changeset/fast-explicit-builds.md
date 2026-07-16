---
'storyfreeze': patch
---

Avoid rebuilding StoryFreeze during dependency installation and package packing; repository and release workflows now build it explicitly once before consuming the tarball.
