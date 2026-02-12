module MrmdJulia

using HTTP
using JSON3
using Dates
using UUIDs
using Sockets
using REPL

# Include source files
include("types.jl")
include("worker.jl")
include("server.jl")

# Re-export main types and functions
export start_server
export MRPServer
export JuliaWorker
export execute, execute_streaming
export complete, hover, inspect
export get_variables, get_variable_detail
export is_complete, reset!, interrupt!

# Export types
export ExecuteResult, ExecuteError
export CompletionItem, CompleteResult
export HoverResult, InspectResult
export Variable, VariablesResult, VariableDetail
export SessionInfo, Capabilities, Features, Environment
export DisplayData, Asset

end # module
