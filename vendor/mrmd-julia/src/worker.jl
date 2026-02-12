# Julia execution worker for MRP
# Note: types.jl is included by MrmdJulia.jl before this file

using Dates
using REPL
using REPL.LineEdit

"""
Persistent Julia session worker.

Maintains a module scope for code execution with variable persistence.
Supports streaming output, completions, hover, and variable inspection.
"""
mutable struct JuliaWorker
    cwd::String
    assets_dir::String
    execution_count::Int
    created::DateTime
    last_activity::DateTime

    # Execution module - variables persist here
    mod::Module

    # Interrupt flag
    interrupted::Bool

    # Pending input
    pending_input::Union{Channel{String}, Nothing}
    input_cancelled::Bool

    # Lock for thread safety
    lock::ReentrantLock
end

function JuliaWorker(; cwd::String=pwd(), assets_dir::String=joinpath(cwd, ".mrmd-assets"))
    # Create a fresh module for code execution
    mod = Module(:MrmdSession)

    # Make sure assets directory exists
    isdir(assets_dir) || mkpath(assets_dir)

    JuliaWorker(
        cwd,
        assets_dir,
        0,
        now(UTC),
        now(UTC),
        mod,
        false,
        nothing,
        false,
        ReentrantLock()
    )
end

"""
Execute Julia code and return the result.
"""
function execute(worker::JuliaWorker, code::String;
                 store_history::Bool=true,
                 exec_id::String="")::ExecuteResult
    execute_streaming(worker, code;
                      store_history=store_history,
                      exec_id=exec_id,
                      on_output=nothing,
                      on_stdin_request=nothing)
end

"""
Execute Julia code with streaming output support.
"""
function execute_streaming(worker::JuliaWorker, code::String;
                           store_history::Bool=true,
                           exec_id::String="",
                           on_output::Union{Function, Nothing}=nothing,
                           on_stdin_request::Union{Function, Nothing}=nothing)::ExecuteResult
    lock(worker.lock) do
        worker.interrupted = false
        worker.input_cancelled = false
        worker.last_activity = now(UTC)

        if store_history
            worker.execution_count += 1
        end

        start_time = time()

        # Always use pipes for output capture (IOBuffer redirect doesn't work in Julia 1.8)
        stdout_pipe = Pipe()
        stderr_pipe = Pipe()
        stdout_buf = IOBuffer()
        stderr_buf = IOBuffer()

        accumulated_stdout = ""
        accumulated_stderr = ""

        result_value = nothing
        error_info = nothing
        display_data = DisplayData[]
        assets = Asset[]

        try
            # Change to working directory
            old_dir = pwd()
            cd(worker.cwd)

            # Redirect output using pipes
            old_stdout = stdout
            old_stderr = stderr

            Base.link_pipe!(stdout_pipe; reader_supports_async=true, writer_supports_async=true)
            Base.link_pipe!(stderr_pipe; reader_supports_async=true, writer_supports_async=true)

            redirect_stdout(stdout_pipe.in)
            redirect_stderr(stderr_pipe.in)

            # Start async readers
            stdout_task = @async begin
                try
                    while isopen(stdout_pipe.out) || bytesavailable(stdout_pipe.out) > 0
                        data = String(readavailable(stdout_pipe.out))
                        if !isempty(data)
                            accumulated_stdout *= data
                            write(stdout_buf, data)
                            if on_output !== nothing
                                on_output("stdout", data, accumulated_stdout)
                            end
                        end
                        sleep(0.01)
                    end
                catch e
                    if !(e isa EOFError || e isa Base.IOError)
                        @error "Error reading stdout" exception=(e, catch_backtrace())
                    end
                end
            end

            stderr_task = @async begin
                try
                    while isopen(stderr_pipe.out) || bytesavailable(stderr_pipe.out) > 0
                        data = String(readavailable(stderr_pipe.out))
                        if !isempty(data)
                            accumulated_stderr *= data
                            write(stderr_buf, data)
                            if on_output !== nothing
                                on_output("stderr", data, accumulated_stderr)
                            end
                        end
                        sleep(0.01)
                    end
                catch e
                    if !(e isa EOFError || e isa Base.IOError)
                        @error "Error reading stderr" exception=(e, catch_backtrace())
                    end
                end
            end

            try
                # Parse and evaluate the code
                exprs = Meta.parseall(code)

                if exprs.head == :toplevel
                    # Multiple expressions
                    for expr in exprs.args
                        if expr isa LineNumberNode
                            continue
                        end

                        # Check for interrupt
                        if worker.interrupted
                            throw(InterruptException())
                        end

                        result_value = Core.eval(worker.mod, expr)
                    end
                else
                    result_value = Core.eval(worker.mod, exprs)
                end

                # Check for plot output and save as asset
                if result_value !== nothing
                    assets = check_for_plot_output(worker, result_value, exec_id)
                    display_data = check_for_display_data(result_value)
                end

            finally
                # Restore output streams
                redirect_stdout(old_stdout)
                redirect_stderr(old_stderr)

                # Close pipes and wait for readers
                close(stdout_pipe.in)
                close(stderr_pipe.in)

                # Give readers time to finish
                sleep(0.1)

                try
                    wait(stdout_task)
                    wait(stderr_task)
                catch
                    # Ignore task errors
                end

                cd(old_dir)
            end

            duration = round(Int, (time() - start_time) * 1000)

            # Format result for display
            result_str = if result_value === nothing
                nothing
            else
                try
                    # Use show to format the result
                    io = IOBuffer()
                    show(io, MIME("text/plain"), result_value)
                    String(take!(io))
                catch
                    repr(result_value)
                end
            end

            stdout_str = accumulated_stdout
            stderr_str = accumulated_stderr

            return ExecuteResult(
                success=true,
                stdout=stdout_str,
                stderr=stderr_str,
                result=result_str,
                error=nothing,
                displayData=display_data,
                assets=assets,
                executionCount=worker.execution_count,
                duration=duration
            )

        catch e
            duration = round(Int, (time() - start_time) * 1000)

            # Format error
            error_type = string(typeof(e))
            error_msg = sprint(showerror, e)

            # Get traceback
            traceback_lines = String[]
            try
                bt = catch_backtrace()
                for frame in stacktrace(bt)
                    push!(traceback_lines, string(frame))
                end
            catch
                # Ignore traceback errors
            end

            # Extract line/column if available
            line_num = nothing
            col_num = nothing
            if e isa Meta.ParseError
                # Try to extract line info from parse error
            end

            stdout_str = on_output !== nothing ? accumulated_stdout : String(take!(stdout_buf))
            stderr_str = on_output !== nothing ? accumulated_stderr : String(take!(stderr_buf))

            return ExecuteResult(
                success=false,
                stdout=stdout_str,
                stderr=stderr_str,
                result=nothing,
                error=ExecuteError(
                    type=error_type,
                    message=error_msg,
                    traceback=traceback_lines,
                    line=line_num,
                    column=col_num
                ),
                displayData=DisplayData[],
                assets=Asset[],
                executionCount=worker.execution_count,
                duration=duration
            )
        end
    end
end

"""
Check if result is a plot and save as asset.
"""
function check_for_plot_output(worker::JuliaWorker, result, exec_id::String)::Vector{Asset}
    assets = Asset[]

    # Try to get the Plots module if it's loaded
    Plots_mod = nothing
    try
        # Check if Plots is loaded in any way
        if isdefined(worker.mod, :Plots)
            Plots_mod = getfield(worker.mod, :Plots)
            @info "Found Plots via worker.mod"
        elseif haskey(Base.loaded_modules, Base.PkgId(Base.UUID("91a5bcdd-55d7-5caf-9e0b-520d859cae80"), "Plots"))
            Plots_mod = Base.loaded_modules[Base.PkgId(Base.UUID("91a5bcdd-55d7-5caf-9e0b-520d859cae80"), "Plots")]
            @info "Found Plots via Base.loaded_modules"
        else
            @info "Plots module not found" isdefined_plots=isdefined(worker.mod, :Plots) isdefined_plot=isdefined(worker.mod, :plot)
        end
    catch e
        @warn "Error finding Plots module" exception=e
    end

    # Check for Plots.jl - either result is a plot or there's a current figure
    has_plots = Plots_mod !== nothing || hasproperty(result, :layout)

    if has_plots
        try
            # Generate unique filename
            filename = "plot_$(exec_id)_$(time_ns()).png"
            filepath = joinpath(worker.assets_dir, filename)

            # Check if result itself is a plot
            is_plot_result = hasproperty(result, :layout) ||
                            (result !== nothing && string(typeof(result)) |> x -> occursin("Plot", x))

            if is_plot_result
                # This looks like a Plots.jl plot - save it directly
                savefig_fn = isdefined(worker.mod, :savefig) ? getfield(worker.mod, :savefig) :
                             (Plots_mod !== nothing ? Plots_mod.savefig : nothing)
                if savefig_fn !== nothing
                    savefig_fn(result, filepath)

                    push!(assets, Asset(
                        path=filepath,
                        url="/mrp/v1/assets/$filename",
                        mimeType="image/png",
                        assetType="plot",
                        size=filesize(filepath)
                    ))
                end
            elseif Plots_mod !== nothing
                # Result isn't a plot, but check if there's a current Plots.jl figure
                # This handles cases like: plot(...); println("done") where println is the result
                try
                    if isdefined(Plots_mod, :current)
                        current_plot = Plots_mod.current()
                        if current_plot !== nothing && hasproperty(current_plot, :layout)
                            Plots_mod.savefig(current_plot, filepath)

                            push!(assets, Asset(
                                path=filepath,
                                url="/mrp/v1/assets/$filename",
                                mimeType="image/png",
                                assetType="plot",
                                size=filesize(filepath)
                            ))
                        end
                    end
                catch e
                    @debug "Could not save current plot" exception=e
                end
            end
        catch e
            @warn "Failed to save plot" exception=e
        end
    end

    # Check for Makie.jl / CairoMakie.jl
    type_str = string(typeof(result))
    if occursin("Figure", type_str) || occursin("Scene", type_str)
        try
            filename = "plot_$(exec_id)_$(time_ns()).png"
            filepath = joinpath(worker.assets_dir, filename)

            # Try CairoMakie save
            if isdefined(worker.mod, :save)
                save = getfield(worker.mod, :save)
                save(filepath, result)

                push!(assets, Asset(
                    path=filepath,
                    url="/mrp/v1/assets/$filename",
                    mimeType="image/png",
                    assetType="plot",
                    size=filesize(filepath)
                ))
            end
        catch e
            @warn "Failed to save Makie plot" exception=e
        end
    end

    return assets
end

"""
Check for rich display data (HTML, SVG, etc.).
"""
function check_for_display_data(result)::Vector{DisplayData}
    display_data = DisplayData[]

    # Check for HTML representation
    if showable(MIME("text/html"), result)
        try
            io = IOBuffer()
            show(io, MIME("text/html"), result)
            html = String(take!(io))
            if !isempty(html)
                push!(display_data, DisplayData(
                    data=Dict("text/html" => html),
                    metadata=Dict{String, Any}()
                ))
            end
        catch
        end
    end

    # Check for SVG representation
    if showable(MIME("image/svg+xml"), result)
        try
            io = IOBuffer()
            show(io, MIME("image/svg+xml"), result)
            svg = String(take!(io))
            if !isempty(svg)
                push!(display_data, DisplayData(
                    data=Dict("image/svg+xml" => svg),
                    metadata=Dict{String, Any}()
                ))
            end
        catch
        end
    end

    return display_data
end

"""
Interrupt the current execution.
"""
function interrupt!(worker::JuliaWorker)::Bool
    worker.interrupted = true
    # TODO: Actually interrupt running task if possible
    return true
end

"""
Get completions for code at cursor position.
"""
function complete(worker::JuliaWorker, code::String, cursor_pos::Int)::CompleteResult
    matches = CompletionItem[]

    try
        # Use Julia's REPL completion
        completions, range, should_complete = REPL.completions(code, cursor_pos, worker.mod)

        cursor_start = first(range) - 1  # Convert to 0-based
        cursor_end = cursor_pos

        for comp in completions
            comp_text = REPL.completion_text(comp)

            # Determine kind
            kind = "text"
            if comp isa REPL.ModuleCompletion
                kind = "module"
            elseif comp isa REPL.MethodCompletion
                kind = "function"
            elseif comp isa REPL.FieldCompletion
                kind = "field"
            elseif comp isa REPL.KeywordCompletion
                kind = "keyword"
            elseif comp isa REPL.PathCompletion
                kind = "file"
            end

            push!(matches, CompletionItem(
                label=comp_text,
                insertText=comp_text,
                kind=kind,
                detail=nothing,
                documentation=nothing
            ))
        end

        return CompleteResult(
            matches=matches[1:min(50, length(matches))],  # Limit to 50
            cursorStart=cursor_start,
            cursorEnd=cursor_end,
            source="runtime"
        )
    catch e
        @warn "Completion error" exception=e
        return CompleteResult(
            matches=CompletionItem[],
            cursorStart=cursor_pos,
            cursorEnd=cursor_pos,
            source="runtime"
        )
    end
end

"""
Get hover information for symbol at cursor.
"""
function hover(worker::JuliaWorker, code::String, cursor_pos::Int)::HoverResult
    try
        # Extract word at cursor
        word = extract_word_at_cursor(code, cursor_pos)
        if isempty(word)
            return HoverResult(found=false)
        end

        # Try to find the symbol in the module
        sym = Symbol(word)

        if isdefined(worker.mod, sym)
            val = getfield(worker.mod, sym)
            type_str = string(typeof(val))

            # Get value preview
            value_preview = try
                io = IOBuffer()
                show(IOContext(io, :limit => true, :displaysize => (10, 80)), val)
                preview = String(take!(io))
                length(preview) > 200 ? preview[1:200] * "..." : preview
            catch
                nothing
            end

            # Get signature for functions
            sig = nothing
            if val isa Function
                methods_list = methods(val)
                if length(methods_list) > 0
                    sig = string(first(methods_list).sig)
                end
            end

            return HoverResult(
                found=true,
                name=word,
                type=type_str,
                value=value_preview,
                signature=sig
            )
        end

        # Check if it's a built-in
        if isdefined(Base, sym)
            val = getfield(Base, sym)
            type_str = string(typeof(val))

            return HoverResult(
                found=true,
                name=word,
                type=type_str,
                value=nothing,
                signature=nothing
            )
        end

        return HoverResult(found=false)
    catch e
        @warn "Hover error" exception=e
        return HoverResult(found=false)
    end
end

"""
Get detailed inspection information.
"""
function inspect(worker::JuliaWorker, code::String, cursor_pos::Int; detail::Int=1)::InspectResult
    try
        word = extract_word_at_cursor(code, cursor_pos)
        if isempty(word)
            return InspectResult(found=false)
        end

        sym = Symbol(word)

        # Check module first, then Base
        mod_to_check = isdefined(worker.mod, sym) ? worker.mod : Base

        if !isdefined(mod_to_check, sym)
            return InspectResult(found=false)
        end

        val = getfield(mod_to_check, sym)
        type_str = string(typeof(val))

        # Get docstring
        docstring = try
            io = IOBuffer()
            # Use @doc macro to get documentation
            doc = Base.Docs.doc(val)
            show(io, MIME("text/plain"), doc)
            String(take!(io))
        catch
            nothing
        end

        # Get source location for functions
        file = nothing
        line = nothing
        source_code = nothing

        if val isa Function
            try
                m = first(methods(val))
                file = string(m.file)
                line = m.line

                if detail >= 2 && file !== nothing && isfile(file)
                    # Read source code around the function
                    source_lines = readlines(file)
                    start_line = max(1, line - 2)
                    end_line = min(length(source_lines), line + 20)
                    source_code = join(source_lines[start_line:end_line], "\n")
                end
            catch
            end
        end

        # Get value preview
        value_preview = try
            io = IOBuffer()
            show(IOContext(io, :limit => true), val)
            String(take!(io))
        catch
            nothing
        end

        return InspectResult(
            found=true,
            source="runtime",
            name=word,
            kind=val isa Function ? "function" : val isa Module ? "module" : "variable",
            type=type_str,
            signature=nothing,
            docstring=docstring,
            sourceCode=source_code,
            file=file,
            line=line,
            value=value_preview,
            children=nothing
        )
    catch e
        @warn "Inspect error" exception=e
        return InspectResult(found=false)
    end
end

"""
Get list of variables in the session.
"""
function get_variables(worker::JuliaWorker; filter_pattern::Union{String, Nothing}=nothing)::VariablesResult
    variables = Variable[]

    try
        for name in names(worker.mod; all=true)
            name_str = string(name)

            # Skip internal names
            if startswith(name_str, "#") || startswith(name_str, "_")
                continue
            end

            # Apply filter if provided
            if filter_pattern !== nothing
                if !occursin(Regex(filter_pattern), name_str)
                    continue
                end
            end

            if !isdefined(worker.mod, name)
                continue
            end

            val = getfield(worker.mod, name)

            # Skip modules and functions by default
            if val isa Module || val isa Function
                continue
            end

            type_str = string(typeof(val))

            # Get value preview
            value_preview = try
                io = IOBuffer()
                show(IOContext(io, :limit => true, :displaysize => (3, 80)), val)
                preview = String(take!(io))
                length(preview) > 100 ? preview[1:100] * "..." : preview
            catch
                "<error getting value>"
            end

            # Determine size
            size_str = nothing
            expandable = false
            shape = nothing
            len = nothing

            if val isa AbstractArray
                shape = collect(size(val))
                size_str = join(shape, " x ")
                expandable = length(val) > 0
                len = length(val)
            elseif val isa AbstractDict
                len = length(val)
                size_str = "$len entries"
                expandable = len > 0
            elseif val isa AbstractString
                len = length(val)
                size_str = "$len chars"
            end

            push!(variables, Variable(
                name=name_str,
                type=type_str,
                value=value_preview,
                size=size_str,
                expandable=expandable,
                shape=shape,
                length=len
            ))
        end

        # Sort by name
        sort!(variables, by=v -> v.name)

        truncated = length(variables) > 200
        variables = variables[1:min(200, length(variables))]

        return VariablesResult(
            variables=variables,
            count=length(variables),
            truncated=truncated
        )
    catch e
        @warn "Get variables error" exception=e
        return VariablesResult(variables=Variable[], count=0, truncated=false)
    end
end

"""
Get detailed information about a specific variable.
"""
function get_variable_detail(worker::JuliaWorker, name::String; path::Union{Vector{String}, Nothing}=nothing)::VariableDetail
    try
        sym = Symbol(name)

        if !isdefined(worker.mod, sym)
            return VariableDetail(name=name, type="undefined", value="")
        end

        val = getfield(worker.mod, sym)

        # Navigate path if provided
        if path !== nothing && !isempty(path)
            for key in path
                if val isa AbstractDict
                    val = val[key]
                elseif val isa AbstractArray
                    idx = parse(Int, key)
                    val = val[idx]
                elseif hasproperty(val, Symbol(key))
                    val = getproperty(val, Symbol(key))
                else
                    return VariableDetail(name=name, type="error", value="Cannot navigate path")
                end
            end
        end

        type_str = string(typeof(val))

        # Get full value
        full_value = try
            io = IOBuffer()
            show(IOContext(io, :limit => false), MIME("text/plain"), val)
            String(take!(io))
        catch
            repr(val)
        end

        # Get truncated value
        value_preview = length(full_value) > 100 ? full_value[1:100] * "..." : full_value

        # Get children for expandable types
        children = nothing
        if val isa AbstractDict && length(val) > 0
            children = Variable[]
            for (k, v) in val
                k_str = string(k)
                push!(children, Variable(
                    name=k_str,
                    type=string(typeof(v)),
                    value=try sprint(show, v) catch; "<error>" end,
                    expandable=v isa AbstractDict || v isa AbstractArray
                ))
            end
        elseif val isa AbstractArray && length(val) <= 100
            children = Variable[]
            for (i, v) in enumerate(val)
                push!(children, Variable(
                    name=string(i),
                    type=string(typeof(v)),
                    value=try sprint(show, v) catch; "<error>" end,
                    expandable=v isa AbstractDict || v isa AbstractArray
                ))
            end
        end

        return VariableDetail(
            name=name,
            type=type_str,
            value=value_preview,
            fullValue=full_value,
            expandable=children !== nothing && !isempty(children),
            length=val isa Union{AbstractArray, AbstractDict, AbstractString} ? length(val) : nothing,
            children=children,
            truncated=length(full_value) > 10000
        )
    catch e
        @warn "Get variable detail error" exception=e
        return VariableDetail(name=name, type="error", value=string(e))
    end
end

"""
Check if code is complete (can be executed).
"""
function is_complete(worker::JuliaWorker, code::String)::IsCompleteResult
    try
        # Try to parse the code
        exprs = Meta.parse(code, raise=false)

        if exprs isa Expr && exprs.head == :incomplete
            return IsCompleteResult(status="incomplete", indent="  ")
        elseif exprs isa Expr && exprs.head == :error
            return IsCompleteResult(status="invalid", indent="")
        else
            return IsCompleteResult(status="complete", indent="")
        end
    catch e
        if e isa Meta.ParseError
            msg = string(e)
            if occursin("incomplete", lowercase(msg))
                return IsCompleteResult(status="incomplete", indent="  ")
            else
                return IsCompleteResult(status="invalid", indent="")
            end
        end
        return IsCompleteResult(status="unknown", indent="")
    end
end

"""
Reset the session (clear all variables).
"""
function reset!(worker::JuliaWorker)
    lock(worker.lock) do
        worker.mod = Module(:MrmdSession)
        worker.execution_count = 0
        worker.last_activity = now(UTC)
    end
end

"""
Shutdown the worker.
"""
function shutdown!(worker::JuliaWorker)
    # Nothing special to clean up for Julia
end

"""
Get worker information.
"""
function get_info(worker::JuliaWorker)::Dict{String, Any}
    Dict{String, Any}(
        "cwd" => worker.cwd,
        "assets_dir" => worker.assets_dir,
        "execution_count" => worker.execution_count,
        "created" => Dates.format(worker.created, ISODateTimeFormat),
        "last_activity" => Dates.format(worker.last_activity, ISODateTimeFormat),
        "julia_version" => string(VERSION)
    )
end

# Helper functions

"""
Extract the word at cursor position.
"""
function extract_word_at_cursor(code::String, cursor_pos::Int)::String
    if isempty(code) || cursor_pos <= 0
        return ""
    end

    # Clamp cursor position
    cursor_pos = min(cursor_pos, length(code))

    # Find word boundaries
    start_pos = cursor_pos
    end_pos = cursor_pos

    # Word characters in Julia
    is_word_char(c) = isletter(c) || isdigit(c) || c == '_' || c == '!'

    # Go backward
    while start_pos > 1 && is_word_char(code[start_pos - 1])
        start_pos -= 1
    end

    # Go forward
    while end_pos < length(code) && is_word_char(code[end_pos + 1])
        end_pos += 1
    end

    return code[start_pos:end_pos]
end
