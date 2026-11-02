# EvilCharts

Source components installed from the official [EvilCharts registry](https://evilcharts.com/docs/recharts/installation):

```sh
pnpm exec shadcn add @evilcharts/recharts-area-chart @evilcharts/recharts-bar-chart
```

These use the project's existing Recharts engine and the `motion` dependency.
Local adaptations: project import aliases, formatting, type-only imports, unused
import cleanup, wrapping legends, and keyboard/focus support for clickable legends.
Analytics supplies recorded data and disables chart entrance animations.
