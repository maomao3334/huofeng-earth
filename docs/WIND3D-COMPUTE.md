# Wind3D computation

The application can submit supported jobs to a separately installed Wind3D runtime. The runtime and its dependencies are not bundled in this repository.

## Configure the runner

Set `WIND3D_CLI` to the local command or script that starts your compatible Wind3D runtime. The application checks its status through the local runner before enabling compute workflows.

```powershell
$env:WIND3D_CLI = 'C:\\path\\to\\your\\wind3d-runner.cmd'
```

Restart the application after changing the environment variable. Do not place a runner binary or runtime data in this repository.

## Inputs and results

Jobs may use observation tables, station metadata, a user-selected terrain file, and a model configuration. Select these through the application and confirm their coordinate system, units, time zone, and authorization before submitting a job.

Job results are written to the local installation's runtime directory. They are not part of the source repository. Use a synthetic test case when reporting a problem; never attach operational observations or model output to a public issue.

## Supported workflows

The user interface exposes regular wind-field computation, turbulence, observation-profile assimilation, and coupled native-RANS assimilation when the configured runner reports support. The native-RANS workflow has not passed convergence acceptance for the current synthetic check; do not treat an output file or successful process exit as proof that this mode is scientifically valid.

For display-only workflows, see [WindNinja input](WINDNINJA.md) and [vertical wind profiles](WIND-PROFILE.md).
