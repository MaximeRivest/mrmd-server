# mrmd-julia

Julia runtime server for MRMD (Markdown Runtime Multi-Document).

Implements the MRP (MRMD Runtime Protocol) for Julia code execution, providing:
- Code execution with streaming output
- Completions
- Hover information
- Variable inspection
- Plot/asset capture (Plots.jl, Makie.jl)
- Session management

## Requirements

- Julia 1.9 or later
- HTTP.jl, JSON3.jl, StructTypes.jl (auto-installed)

## Installation

```bash
cd mrmd-julia
julia --project=. -e 'using Pkg; Pkg.instantiate()'
```

## Usage

### CLI

```bash
# Start the server
julia --project=. bin/mrmd-julia --port 8000 --cwd /path/to/project

# Or use the executable directly
./bin/mrmd-julia --port 8000
```

### From Julia

```julia
using MrmdJulia

# Start server
start_server(port=8000, host="127.0.0.1", cwd=pwd())
```

## MRP Endpoints

All endpoints are under `/mrp/v1/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/capabilities` | GET | Server capabilities |
| `/sessions` | GET/POST | List/create sessions |
| `/sessions/{id}` | GET/DELETE | Get/delete session |
| `/sessions/{id}/reset` | POST | Reset session |
| `/execute` | POST | Execute code (sync) |
| `/execute/stream` | POST | Execute code (SSE streaming) |
| `/interrupt` | POST | Interrupt execution |
| `/complete` | POST | Get completions |
| `/inspect` | POST | Get detailed info |
| `/hover` | POST | Get hover info |
| `/variables` | POST | List variables |
| `/variables/{name}` | POST | Get variable detail |
| `/is_complete` | POST | Check if code is complete |
| `/assets/{path}` | GET | Serve saved assets (plots) |

## Features

### Code Execution

```julia
# Streaming execution with SSE
POST /mrp/v1/execute/stream
{
  "code": "for i in 1:5\n  println(i)\n  sleep(0.5)\nend",
  "session": "default"
}

# Events: start, stdout, stderr, result/error, done
```

### Completions

```julia
POST /mrp/v1/complete
{
  "code": "prin",
  "cursor": 4,
  "session": "default"
}
```

### Variable Inspection

```julia
POST /mrp/v1/variables
{
  "session": "default"
}
```

### Plot Capture

When using Plots.jl or Makie.jl, plots are automatically saved as PNG assets:

```julia
using Plots
plot(1:10, rand(10))
# Returns asset URL in result
```

## Configuration in mrmd.md

```yaml
session:
  julia:
    cwd: "."
    name: "default"
    auto_start: true
```

## License

MIT
