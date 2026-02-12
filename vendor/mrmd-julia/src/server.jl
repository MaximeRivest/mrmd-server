# MRP HTTP Server for Julia runtime
#
# Implements the MRMD Runtime Protocol (MRP) over HTTP with SSE streaming.
#
# The server exposes endpoints at /mrp/v1/* for:
# - Code execution (sync and streaming)
# - Completions, hover, and inspect
# - Variable inspection
# - Session management
# - Asset serving (for plots, HTML output, etc.)
#
# Note: types.jl and worker.jl are included by MrmdJulia.jl before this file

using HTTP
using JSON3
using Dates
using UUIDs
using Sockets

# Global session manager
mutable struct SessionManager
    sessions::Dict{String, Tuple{JuliaWorker, SessionInfo}}
    cwd::String
    assets_dir::String
    lock::ReentrantLock
end

function SessionManager(; cwd::String=pwd(), assets_dir::String=joinpath(cwd, ".mrmd-assets"))
    SessionManager(
        Dict{String, Tuple{JuliaWorker, SessionInfo}}(),
        cwd,
        assets_dir,
        ReentrantLock()
    )
end

function get_or_create_session!(manager::SessionManager, session_id::String)
    lock(manager.lock) do
        if haskey(manager.sessions, session_id)
            worker, info = manager.sessions[session_id]
            info.lastActivity = Dates.format(now(UTC), ISODateTimeFormat)
            return worker, info
        end

        # Create new session
        worker = JuliaWorker(cwd=manager.cwd, assets_dir=manager.assets_dir)
        info = SessionInfo(
            id=session_id,
            language="julia",
            created=Dates.format(now(UTC), ISODateTimeFormat),
            lastActivity=Dates.format(now(UTC), ISODateTimeFormat),
            executionCount=0,
            variableCount=0
        )
        manager.sessions[session_id] = (worker, info)
        return worker, info
    end
end

function get_session(manager::SessionManager, session_id::String)
    lock(manager.lock) do
        get(manager.sessions, session_id, nothing)
    end
end

function list_sessions(manager::SessionManager)::Vector{SessionInfo}
    lock(manager.lock) do
        [info for (_, info) in values(manager.sessions)]
    end
end

function destroy_session!(manager::SessionManager, session_id::String)::Bool
    lock(manager.lock) do
        if haskey(manager.sessions, session_id)
            worker, _ = pop!(manager.sessions, session_id)
            shutdown!(worker)
            return true
        end
        return false
    end
end

"""
MRP Server for Julia.
"""
mutable struct MRPServer
    cwd::String
    assets_dir::String
    session_manager::SessionManager
end

function MRPServer(; cwd::String=pwd(), assets_dir::String=joinpath(cwd, ".mrmd-assets"))
    isdir(assets_dir) || mkpath(assets_dir)

    MRPServer(
        cwd,
        assets_dir,
        SessionManager(cwd=cwd, assets_dir=assets_dir)
    )
end

"""
Get server capabilities.
"""
function get_capabilities(server::MRPServer)::Capabilities
    Capabilities(
        runtime="mrmd-julia",
        version="0.1.0",
        languages=["julia", "jl"],
        features=Features(),
        defaultSession="default",
        maxSessions=10,
        environment=Environment(
            cwd=server.cwd,
            executable=Base.julia_cmd().exec[1]
        )
    )
end

# =========================================================================
# Route Handlers
# =========================================================================

function handle_capabilities(server::MRPServer, req::HTTP.Request)
    caps = get_capabilities(server)
    return HTTP.Response(200, json_headers(), JSON3.write(caps))
end

function handle_list_sessions(server::MRPServer, req::HTTP.Request)
    sessions = list_sessions(server.session_manager)
    return HTTP.Response(200, json_headers(), JSON3.write(Dict("sessions" => sessions)))
end

function handle_create_session(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))
    session_id = get(body, :id, string(uuid4())[1:8])

    worker, info = get_or_create_session!(server.session_manager, session_id)
    return HTTP.Response(200, json_headers(), JSON3.write(info))
end

function handle_get_session(server::MRPServer, req::HTTP.Request, session_id::String)
    result = get_session(server.session_manager, session_id)
    if result === nothing
        return HTTP.Response(404, json_headers(), JSON3.write(Dict("error" => "Session not found")))
    end
    _, info = result
    return HTTP.Response(200, json_headers(), JSON3.write(info))
end

function handle_delete_session(server::MRPServer, req::HTTP.Request, session_id::String)
    if destroy_session!(server.session_manager, session_id)
        return HTTP.Response(200, json_headers(), JSON3.write(Dict("success" => true)))
    end
    return HTTP.Response(404, json_headers(), JSON3.write(Dict("error" => "Session not found")))
end

function handle_reset_session(server::MRPServer, req::HTTP.Request, session_id::String)
    result = get_session(server.session_manager, session_id)
    if result === nothing
        return HTTP.Response(404, json_headers(), JSON3.write(Dict("error" => "Session not found")))
    end
    worker, info = result
    reset!(worker)
    info.executionCount = 0
    info.variableCount = 0
    return HTTP.Response(200, json_headers(), JSON3.write(Dict("success" => true)))
end

function handle_execute(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    # Handle null session - coalesce to "default"
    session_id = something(get(body, :session, nothing), "default")
    store_history = get(body, :storeHistory, true)
    exec_id = get(body, :execId, string(uuid4())[1:8])

    worker, info = get_or_create_session!(server.session_manager, session_id)

    result = execute(worker, code; store_history=store_history, exec_id=exec_id)

    info.executionCount = result.executionCount
    info.variableCount = get_variables(worker).count

    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_execute_stream(server::MRPServer, req::HTTP.Request)
    # NOTE: True SSE streaming requires HTTP.jl streaming API which has compatibility issues.
    # For now, fall back to non-streaming execution (same as /execute endpoint).
    # The result is still valid MRP format, just not streamed incrementally.
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    # Handle null session - coalesce to "default"
    session_id = something(get(body, :session, nothing), "default")
    store_history = get(body, :storeHistory, true)
    exec_id = get(body, :execId, string(uuid4())[1:8])

    worker, info = get_or_create_session!(server.session_manager, session_id)

    result = execute(worker, code; store_history=store_history, exec_id=exec_id)

    info.executionCount = result.executionCount
    info.variableCount = get_variables(worker).count

    # Return as SSE format for compatibility with streaming clients
    # Single "result" event followed by "done"
    sse_body = IOBuffer()
    write_sse_event(sse_body, "start", Dict(
        "execId" => exec_id,
        "timestamp" => Dates.format(now(UTC), ISODateTimeFormat)
    ))

    # Send stdout/stderr if present
    if !isempty(result.stdout)
        write_sse_event(sse_body, "stdout", Dict(
            "content" => result.stdout,
            "accumulated" => result.stdout
        ))
    end
    if !isempty(result.stderr)
        write_sse_event(sse_body, "stderr", Dict(
            "content" => result.stderr,
            "accumulated" => result.stderr
        ))
    end

    if result.success
        write_sse_event(sse_body, "result", result)
    else
        write_sse_event(sse_body, "error", result.error)
    end
    write_sse_event(sse_body, "done", Dict())

    return HTTP.Response(200, sse_headers(), String(take!(sse_body)))
end

function handle_interrupt(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))
    session_id = something(get(body, :session, nothing), "default")

    result = get_session(server.session_manager, session_id)
    if result === nothing
        return HTTP.Response(404, json_headers(), JSON3.write(Dict("interrupted" => false, "error" => "Session not found")))
    end

    worker, _ = result
    interrupted = interrupt!(worker)

    return HTTP.Response(200, json_headers(), JSON3.write(Dict("interrupted" => interrupted)))
end

function handle_complete(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    cursor = get(body, :cursor, length(code))
    session_id = something(get(body, :session, nothing), "default")

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = complete(worker, code, cursor)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_inspect(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    cursor = get(body, :cursor, length(code))
    session_id = something(get(body, :session, nothing), "default")
    detail = get(body, :detail, 1)

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = inspect(worker, code, cursor; detail=detail)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_hover(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    cursor = get(body, :cursor, length(code))
    session_id = something(get(body, :session, nothing), "default")

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = hover(worker, code, cursor)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_variables(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))
    session_id = something(get(body, :session, nothing), "default")

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = get_variables(worker)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_variable_detail(server::MRPServer, req::HTTP.Request, name::String)
    body = JSON3.read(String(req.body))
    session_id = something(get(body, :session, nothing), "default")
    path = get(body, :path, nothing)

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = get_variable_detail(worker, name; path=path)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_is_complete(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))

    code = get(body, :code, "")
    session_id = something(get(body, :session, nothing), "default")

    worker, _ = get_or_create_session!(server.session_manager, session_id)

    result = is_complete(worker, code)
    return HTTP.Response(200, json_headers(), JSON3.write(result))
end

function handle_format(server::MRPServer, req::HTTP.Request)
    body = JSON3.read(String(req.body))
    code = get(body, :code, "")

    # TODO: Integrate JuliaFormatter
    return HTTP.Response(200, json_headers(), JSON3.write(Dict(
        "formatted" => code,
        "changed" => false,
        "error" => "Formatting not yet implemented"
    )))
end

function handle_assets(server::MRPServer, req::HTTP.Request, asset_path::String)
    full_path = joinpath(server.assets_dir, asset_path)

    if !isfile(full_path)
        return HTTP.Response(404, json_headers(), JSON3.write(Dict("error" => "Asset not found")))
    end

    # Determine content type
    ext = lowercase(splitext(full_path)[2])
    content_type = get(Dict(
        ".png" => "image/png",
        ".jpg" => "image/jpeg",
        ".jpeg" => "image/jpeg",
        ".svg" => "image/svg+xml",
        ".html" => "text/html",
        ".json" => "application/json"
    ), ext, "application/octet-stream")

    content = read(full_path)
    return HTTP.Response(200, [
        "Content-Type" => content_type,
        "Access-Control-Allow-Origin" => "*"
    ], content)
end

# =========================================================================
# HTTP Helpers
# =========================================================================

function json_headers()
    [
        "Content-Type" => "application/json",
        "Access-Control-Allow-Origin" => "*",
        "Access-Control-Allow-Methods" => "*",
        "Access-Control-Allow-Headers" => "*"
    ]
end

function sse_headers()
    [
        "Content-Type" => "text/event-stream",
        "Cache-Control" => "no-cache",
        "Connection" => "keep-alive",
        "Access-Control-Allow-Origin" => "*",
        "Access-Control-Allow-Methods" => "*",
        "Access-Control-Allow-Headers" => "*"
    ]
end

function write_sse_event(io, event::String, data)
    write(io, "event: $event\n")
    write(io, "data: $(JSON3.write(data))\n\n")
    flush(io)
end

# =========================================================================
# Router
# =========================================================================

function create_router(server::MRPServer)
    function router(req::HTTP.Request)
        # Handle CORS preflight
        if req.method == "OPTIONS"
            return HTTP.Response(200, [
                "Access-Control-Allow-Origin" => "*",
                "Access-Control-Allow-Methods" => "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers" => "*",
                "Access-Control-Max-Age" => "86400"
            ])
        end

        path = HTTP.URI(req.target).path
        method = req.method

        try
            # Route matching
            if path == "/mrp/v1/capabilities" && method == "GET"
                return handle_capabilities(server, req)
            elseif path == "/mrp/v1/sessions" && method == "GET"
                return handle_list_sessions(server, req)
            elseif path == "/mrp/v1/sessions" && method == "POST"
                return handle_create_session(server, req)
            elseif startswith(path, "/mrp/v1/sessions/") && method == "GET"
                session_id = split(path, "/")[5]
                if !occursin("/", session_id)
                    return handle_get_session(server, req, session_id)
                end
            elseif startswith(path, "/mrp/v1/sessions/") && method == "DELETE"
                session_id = split(path, "/")[5]
                return handle_delete_session(server, req, session_id)
            elseif startswith(path, "/mrp/v1/sessions/") && endswith(path, "/reset") && method == "POST"
                parts = split(path, "/")
                session_id = parts[5]
                return handle_reset_session(server, req, session_id)
            elseif path == "/mrp/v1/execute" && method == "POST"
                return handle_execute(server, req)
            elseif path == "/mrp/v1/execute/stream" && method == "POST"
                return handle_execute_stream(server, req)
            elseif path == "/mrp/v1/interrupt" && method == "POST"
                return handle_interrupt(server, req)
            elseif path == "/mrp/v1/complete" && method == "POST"
                return handle_complete(server, req)
            elseif path == "/mrp/v1/inspect" && method == "POST"
                return handle_inspect(server, req)
            elseif path == "/mrp/v1/hover" && method == "POST"
                return handle_hover(server, req)
            elseif path == "/mrp/v1/variables" && method == "POST"
                return handle_variables(server, req)
            elseif startswith(path, "/mrp/v1/variables/") && method == "POST"
                name = String(split(path, "/")[5])
                return handle_variable_detail(server, req, name)
            elseif path == "/mrp/v1/is_complete" && method == "POST"
                return handle_is_complete(server, req)
            elseif path == "/mrp/v1/format" && method == "POST"
                return handle_format(server, req)
            elseif startswith(path, "/mrp/v1/assets/") && method == "GET"
                asset_path = join(split(path, "/")[5:end], "/")
                return handle_assets(server, req, asset_path)
            end

            # 404 for unknown routes
            return HTTP.Response(404, json_headers(), JSON3.write(Dict("error" => "Not found")))

        catch e
            @error "Request error" exception=(e, catch_backtrace())
            return HTTP.Response(500, json_headers(), JSON3.write(Dict(
                "error" => string(typeof(e)),
                "message" => string(e)
            )))
        end
    end

    return router
end

# =========================================================================
# Server Entry Point
# =========================================================================

"""
Start the MRP server.

# Arguments
- `port::Int`: Port to listen on (default: 8000)
- `host::String`: Host to bind to (default: "127.0.0.1")
- `cwd::String`: Working directory (default: current directory)
- `assets_dir::String`: Directory for assets (default: cwd/.mrmd-assets)
"""
function start_server(;
    port::Int=8000,
    host::String="127.0.0.1",
    cwd::String=pwd(),
    assets_dir::String=joinpath(cwd, ".mrmd-assets")
)
    server = MRPServer(cwd=cwd, assets_dir=assets_dir)
    router = create_router(server)

    @info "Starting mrmd-julia MRP server" host=host port=port cwd=cwd

    # Start HTTP server
    HTTP.serve(router, host, port)
end

# Export main function
export start_server
