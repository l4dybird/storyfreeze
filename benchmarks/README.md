# Browser performance records

Browser backend and isolation changes are compared against a committed record made with the existing React/Vite managed static fixture.

The benchmark excludes dependency installation, package build, Storybook build, and the Vite preview server from the measured process tree. It measures the packed StoryFreeze CLI and all of its Chromium descendants with `parallel=4` after one warm-up run.

Each record contains three measured runs and reports:

- wall-clock time from CLI spawn to exit
- the simultaneous sum of `VmRSS` for the CLI and all descendants, sampled every 50 ms
- peak Chromium browser-root and total Chromium process counts
- discovered Chromium version, runner image, Node version, and fixture versions
- story and PNG counts

Summed RSS includes shared pages in more than one process and is not a PSS measurement. Comparisons must use the same workflow, runner image, Chromium executable, fixture, backend options, and parallelism. Before/after runs should be made close together because GitHub-hosted runner hardware can vary.

The workflow is not a regular CI gate. It runs when benchmark-related files change and can otherwise be started manually with `workflow_dispatch`.

## Current baseline

The [Puppeteer process baseline](./puppeteer-process-baseline.json) was recorded on GitHub Actions with Node 22.18.0 and Google Chrome 150. Its three-run medians are 10,398 ms wall time and 4,282,707,968 bytes (3.99 GiB) summed peak RSS. The run observed four simultaneous browser roots, five browser launches in total (one enumeration process followed by four capture workers), and 38 simultaneous Chromium processes.
