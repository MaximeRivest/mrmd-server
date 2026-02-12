# Type definitions for MRP (MRMD Runtime Protocol) - Julia implementation

using JSON3
using StructTypes

"""
Error information from failed execution.
"""
Base.@kwdef mutable struct ExecuteError
    type::String
    message::String
    traceback::Vector{String} = String[]
    line::Union{Int, Nothing} = nothing
    column::Union{Int, Nothing} = nothing
end

StructTypes.StructType(::Type{ExecuteError}) = StructTypes.Mutable()

"""
Rich display output (for plots, HTML, etc.).
"""
Base.@kwdef mutable struct DisplayData
    data::Dict{String, String}
    metadata::Dict{String, Any} = Dict{String, Any}()
end

StructTypes.StructType(::Type{DisplayData}) = StructTypes.Mutable()

"""
File-based asset created during execution (plots, images, etc.).
"""
Base.@kwdef mutable struct Asset
    path::String
    url::String
    mimeType::String
    assetType::String
    size::Union{Int, Nothing} = nothing
end

StructTypes.StructType(::Type{Asset}) = StructTypes.Mutable()

"""
Result of code execution.
"""
Base.@kwdef mutable struct ExecuteResult
    success::Bool
    stdout::String = ""
    stderr::String = ""
    result::Union{String, Nothing} = nothing
    error::Union{ExecuteError, Nothing} = nothing
    displayData::Vector{DisplayData} = DisplayData[]
    assets::Vector{Asset} = Asset[]
    executionCount::Int = 0
    duration::Int = 0  # milliseconds
end

StructTypes.StructType(::Type{ExecuteResult}) = StructTypes.Mutable()

"""
Single completion suggestion.
"""
Base.@kwdef mutable struct CompletionItem
    label::String
    insertText::Union{String, Nothing} = nothing
    kind::String = "text"
    detail::Union{String, Nothing} = nothing
    documentation::Union{String, Nothing} = nothing
    valuePreview::Union{String, Nothing} = nothing
    type::Union{String, Nothing} = nothing
end

StructTypes.StructType(::Type{CompletionItem}) = StructTypes.Mutable()

"""
Result of completion request.
"""
Base.@kwdef mutable struct CompleteResult
    matches::Vector{CompletionItem} = CompletionItem[]
    cursorStart::Int = 0
    cursorEnd::Int = 0
    source::String = "runtime"
end

StructTypes.StructType(::Type{CompleteResult}) = StructTypes.Mutable()

"""
Result of inspection request.
"""
Base.@kwdef mutable struct InspectResult
    found::Bool = false
    source::String = "runtime"
    name::Union{String, Nothing} = nothing
    kind::Union{String, Nothing} = nothing
    type::Union{String, Nothing} = nothing
    signature::Union{String, Nothing} = nothing
    docstring::Union{String, Nothing} = nothing
    sourceCode::Union{String, Nothing} = nothing
    file::Union{String, Nothing} = nothing
    line::Union{Int, Nothing} = nothing
    value::Union{String, Nothing} = nothing
    children::Union{Vector{Dict}, Nothing} = nothing
end

StructTypes.StructType(::Type{InspectResult}) = StructTypes.Mutable()

"""
Result of hover request.
"""
Base.@kwdef mutable struct HoverResult
    found::Bool = false
    name::Union{String, Nothing} = nothing
    type::Union{String, Nothing} = nothing
    value::Union{String, Nothing} = nothing
    signature::Union{String, Nothing} = nothing
end

StructTypes.StructType(::Type{HoverResult}) = StructTypes.Mutable()

"""
Variable information.
"""
Base.@kwdef mutable struct Variable
    name::String
    type::String
    value::String
    size::Union{String, Nothing} = nothing
    expandable::Bool = false
    shape::Union{Vector{Int}, Nothing} = nothing
    dtype::Union{String, Nothing} = nothing
    length::Union{Int, Nothing} = nothing
    keys::Union{Vector{String}, Nothing} = nothing
end

StructTypes.StructType(::Type{Variable}) = StructTypes.Mutable()

"""
Result of variables list request.
"""
Base.@kwdef mutable struct VariablesResult
    variables::Vector{Variable} = Variable[]
    count::Int = 0
    truncated::Bool = false
end

StructTypes.StructType(::Type{VariablesResult}) = StructTypes.Mutable()

"""
Detailed variable information with children.
"""
Base.@kwdef mutable struct VariableDetail
    name::String
    type::String
    value::String
    size::Union{String, Nothing} = nothing
    expandable::Bool = false
    length::Union{Int, Nothing} = nothing
    fullValue::Union{String, Nothing} = nothing
    children::Union{Vector{Variable}, Nothing} = nothing
    methods::Union{Vector{String}, Nothing} = nothing
    attributes::Union{Vector{String}, Nothing} = nothing
    truncated::Bool = false
end

StructTypes.StructType(::Type{VariableDetail}) = StructTypes.Mutable()

"""
Result of is_complete check.
"""
Base.@kwdef mutable struct IsCompleteResult
    status::String = "unknown"  # "complete", "incomplete", "invalid", "unknown"
    indent::String = ""
end

StructTypes.StructType(::Type{IsCompleteResult}) = StructTypes.Mutable()

"""
Information about a session.
"""
Base.@kwdef mutable struct SessionInfo
    id::String
    language::String = "julia"
    created::String = ""  # ISO8601 timestamp
    lastActivity::String = ""  # ISO8601 timestamp
    executionCount::Int = 0
    variableCount::Int = 0
end

StructTypes.StructType(::Type{SessionInfo}) = StructTypes.Mutable()

"""
Runtime environment information.
"""
Base.@kwdef mutable struct Environment
    cwd::String = pwd()
    executable::String = Base.julia_cmd().exec[1]
    shell::Union{String, Nothing} = nothing
end

StructTypes.StructType(::Type{Environment}) = StructTypes.Mutable()

"""
Runtime feature flags.
"""
Base.@kwdef mutable struct Features
    execute::Bool = true
    executeStream::Bool = true
    interrupt::Bool = true
    complete::Bool = true
    inspect::Bool = true
    hover::Bool = true
    variables::Bool = true
    variableExpand::Bool = true
    reset::Bool = true
    isComplete::Bool = true
    format::Bool = false  # TODO: Add JuliaFormatter support
    assets::Bool = true   # Julia can generate plots
end

StructTypes.StructType(::Type{Features}) = StructTypes.Mutable()

"""
Runtime capabilities response.
"""
Base.@kwdef mutable struct Capabilities
    runtime::String = "mrmd-julia"
    version::String = "0.1.0"
    languages::Vector{String} = ["julia", "jl"]
    features::Features = Features()
    lspFallback::Union{String, Nothing} = nothing
    defaultSession::String = "default"
    maxSessions::Int = 10
    environment::Union{Environment, Nothing} = nothing
end

StructTypes.StructType(::Type{Capabilities}) = StructTypes.Mutable()

"""
Request for user input.
"""
Base.@kwdef mutable struct StdinRequest
    prompt::String = ""
    password::Bool = false
    execId::String = ""
end

StructTypes.StructType(::Type{StdinRequest}) = StructTypes.Mutable()

"""
Exception raised when input is cancelled by the user.
"""
struct InputCancelledError <: Exception
    msg::String
end
InputCancelledError() = InputCancelledError("Input cancelled by user")
