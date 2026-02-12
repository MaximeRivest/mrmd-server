#' Code Execution
#'
#' Execute R code with full output capture using the evaluate package.

#' Handle POST /execute
#' @keywords internal
handle_execute <- function(body) {
  code <- body$code %||% ""
  session_id <- body$session %||% "default"
  store_history <- body$storeHistory %||% TRUE
  exec_id <- body$execId %||% sprintf("exec-%s", as.numeric(Sys.time()))

  # Default asset_dir to {cwd}/_assets if not provided
  asset_dir <- body$assetDir
  if (is.null(asset_dir) || nchar(asset_dir) == 0) {
    asset_dir <- file.path(.mrp_env$cwd, "_assets")
  }

  session <- get_or_create_session(session_id)
  execute_code(session, code, store_history, exec_id, asset_dir)
}

#' Handle POST /execute/stream (SSE)
#' @keywords internal
handle_execute_stream <- function(body, cors_headers) {
  code <- body$code %||% ""
  session_id <- body$session %||% "default"
  store_history <- body$storeHistory %||% TRUE
  exec_id <- body$execId %||% sprintf("exec-%s", as.numeric(Sys.time()))

  # Default asset_dir to {cwd}/_assets if not provided
  asset_dir <- body$assetDir
  if (is.null(asset_dir) || nchar(asset_dir) == 0) {
    asset_dir <- file.path(.mrp_env$cwd, "_assets")
  }

  session <- get_or_create_session(session_id)

  # Return SSE response
  # httpuv doesn't have native SSE support, so we use a custom approach
  # We'll execute and stream events

  headers <- c(cors_headers, list(
    "Content-Type" = "text/event-stream",
    "Cache-Control" = "no-cache",
    "Connection" = "keep-alive"
  ))

  # Build SSE response body
  events <- list()

  # Start event
  events <- c(events, format_sse_event("start", list(
    execId = exec_id,
    timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
  )))

  # Execute with streaming callbacks
  result <- execute_code_streaming(session, code, store_history, exec_id, asset_dir,
    on_output = function(stream, content, accumulated) {
      events <<- c(events, format_sse_event(stream, list(
        content = content,
        accumulated = accumulated
      )))
    },
    on_display = function(data, metadata) {
      events <<- c(events, format_sse_event("display", list(
        data = data,
        metadata = metadata
      )))
    },
    on_asset = function(asset) {
      events <<- c(events, format_sse_event("asset", asset))
    }
  )

  # Result event
  events <- c(events, format_sse_event("result", result))

  # Done event
  events <- c(events, format_sse_event("done", list()))

  list(
    status = 200L,
    headers = headers,
    body = paste(events, collapse = "")
  )
}

#' Format an SSE event
#' @keywords internal
format_sse_event <- function(event_type, data) {
  json_data <- jsonlite::toJSON(data, auto_unbox = TRUE, null = "null")
  sprintf("event: %s\ndata: %s\n\n", event_type, json_data)
}

#' Execute code and return result
#' @keywords internal
execute_code <- function(session, code, store_history, exec_id, asset_dir) {
  execute_code_streaming(session, code, store_history, exec_id, asset_dir,
    on_output = NULL, on_display = NULL, on_asset = NULL)
}

#' Execute code with streaming callbacks
#' @keywords internal
execute_code_streaming <- function(session, code, store_history, exec_id, asset_dir,
                                   on_output = NULL, on_display = NULL, on_asset = NULL) {
  start_time <- Sys.time()
  session$current_exec_id <- exec_id
  session$interrupted <- FALSE

  # Prepare asset directory
  if (!is.null(asset_dir) && nchar(asset_dir) > 0) {
    if (!dir.exists(asset_dir)) {
      dir.create(asset_dir, recursive = TRUE)
    }
  }

  # Set up graphics device for plot capture
  plot_files <- character(0)
  plot_counter <- 0

  # Custom plot hook for evaluate
  plot_hook <- function(plot, hash) {
    if (!is.null(asset_dir) && nchar(asset_dir) > 0) {
      plot_counter <<- plot_counter + 1
      filename <- sprintf("plot-%s-%d.png", exec_id, plot_counter)
      filepath <- file.path(asset_dir, filename)

      # Save the plot
      png(filepath, width = 800, height = 600, res = 96)
      print(plot)
      dev.off()

      # For streaming mode: emit SSE event (editor will handle insertion)
      # For non-streaming mode: add to plot_files for final result
      if (!is.null(on_asset)) {
        on_asset(list(
          path = filepath,
          url = sprintf("/mrp/v1/assets/%s", filename),
          mimeType = "image/png",
          assetType = "image",
          size = file.info(filepath)$size
        ))
      } else {
        # Non-streaming: add to plot_files for inclusion in final assets
        plot_files <<- c(plot_files, filepath)
      }
    }
    invisible(NULL)
  }

  # Capture output
  stdout_acc <- ""
  stderr_acc <- ""
  display_data <- list()
  assets <- list()

  # Use evaluate to run code
  result_value <- NULL
  error_info <- NULL
  eval_result <- NULL

  # Change to session working directory
  old_wd <- getwd()
  setwd(session$env$.mrmd_cwd %||% .mrp_env$cwd)
  on.exit(setwd(old_wd), add = TRUE)

  tryCatch({
    # Evaluate the code
    eval_result <- evaluate::evaluate(
      code,
      envir = session$env,
      stop_on_error = 0,  # Don't stop on error, capture it
      keep_warning = TRUE,
      keep_message = TRUE,
      output_handler = evaluate::new_output_handler(
        text = function(x) {
          stdout_acc <<- paste0(stdout_acc, x)
          if (!is.null(on_output)) {
            on_output("stdout", x, stdout_acc)
          }
        },
        graphics = plot_hook,
        message = function(x) {
          msg <- conditionMessage(x)
          stderr_acc <<- paste0(stderr_acc, msg, "\n")
          if (!is.null(on_output)) {
            on_output("stderr", paste0(msg, "\n"), stderr_acc)
          }
        },
        warning = function(x) {
          msg <- paste0("Warning: ", conditionMessage(x), "\n")
          stderr_acc <<- paste0(stderr_acc, msg)
          if (!is.null(on_output)) {
            on_output("stderr", msg, stderr_acc)
          }
        },
        # Don't set error handler - let evaluate capture errors in result list
        value = function(x, visible) {
          if (visible) {
            result_value <<- x

            # Check if this is a ggplot object - needs special handling
            if (inherits(x, "ggplot") || inherits(x, "gg")) {
              # Save ggplot as asset
              if (!is.null(asset_dir) && nchar(asset_dir) > 0) {
                plot_counter <<- plot_counter + 1
                filename <- sprintf("plot-%s-%d.png", exec_id, plot_counter)
                filepath <- file.path(asset_dir, filename)

                tryCatch({
                  # Try ggsave if ggplot2 is available (it should be since we have a ggplot object)
                  if (requireNamespace("ggplot2", quietly = TRUE)) {
                    ggplot2::ggsave(filepath, plot = x, width = 8, height = 6, dpi = 96)
                  } else {
                    # Fallback: use png() device
                    png(filepath, width = 800, height = 600, res = 96)
                    print(x)
                    dev.off()
                  }

                  # For streaming mode: emit SSE event (editor will handle insertion)
                  # For non-streaming mode: add to plot_files for final result
                  if (!is.null(on_asset)) {
                    on_asset(list(
                      path = filepath,
                      url = sprintf("/mrp/v1/assets/%s", filename),
                      mimeType = "image/png",
                      assetType = "image",
                      size = file.info(filepath)$size
                    ))
                  } else {
                    # Non-streaming: add to plot_files for inclusion in final assets
                    plot_files <<- c(plot_files, filepath)
                  }
                }, error = function(e) {
                  # Fallback: print error but don't crash
                  stderr_acc <<- paste0(stderr_acc, "Warning: Could not save ggplot: ", e$message, "\n")
                })
              }
            } else {
              # Print non-ggplot value to stdout as R would
              output <- capture.output(print(x))
              output_str <- paste(output, collapse = "\n")
              if (nchar(output_str) > 0) {
                stdout_acc <<- paste0(stdout_acc, output_str, "\n")
                if (!is.null(on_output)) {
                  on_output("stdout", paste0(output_str, "\n"), stdout_acc)
                }
              }
            }
          }
        }
      )
    )
  }, error = function(e) {
    error_info <<- list(
      type = class(e)[1],
      message = conditionMessage(e),
      traceback = list(),
      line = NULL,
      column = NULL
    )
  })

  # Check for errors in evaluation result (outside tryCatch)
  if (!is.null(eval_result) && is.null(error_info)) {
    for (item in eval_result) {
      if (inherits(item, "error")) {
        error_info <- list(
          type = class(item)[1],
          message = conditionMessage(item),
          traceback = if (!is.null(item$call)) {
            list(deparse(item$call))
          } else {
            list()
          },
          line = NULL,
          column = NULL
        )
        break
      }
    }
  }

  # Update session
  if (store_history) {
    session$execution_count <- session$execution_count + 1L
  }
  session <- touch_session(session)
  session$current_exec_id <- NULL

  # Build asset list from plot files
  for (filepath in plot_files) {
    filename <- basename(filepath)
    assets <- c(assets, list(list(
      path = filepath,
      url = sprintf("/mrp/v1/assets/%s", filename),
      mimeType = "image/png",
      assetType = "image",
      size = file.info(filepath)$size
    )))
  }

  # Calculate duration
  duration <- as.integer(difftime(Sys.time(), start_time, units = "secs") * 1000)

  # Format result value
  result_str <- NULL
  if (!is.null(result_value) && is.null(error_info)) {
    result_str <- tryCatch(
      paste(capture.output(print(result_value)), collapse = "\n"),
      error = function(e) NULL
    )
  }

  list(
    success = is.null(error_info),
    stdout = stdout_acc,
    stderr = stderr_acc,
    result = result_str,
    error = error_info,
    displayData = display_data,
    assets = assets,
    executionCount = session$execution_count,
    duration = duration
  )
}

#' Handle POST /input
#' @keywords internal
handle_input <- function(body) {
  session_id <- body$session %||% "default"
  exec_id <- body$exec_id
  text <- body$text %||% ""

  if (is.null(exec_id)) {
    return(list(accepted = FALSE, error = "exec_id is required", status = 400L))
  }

  # Store input for pending request
  key <- paste(session_id, exec_id, sep = ":")
  if (key %in% names(.mrp_env$pending_inputs)) {
    .mrp_env$input_values[[key]] <- text
    .mrp_env$pending_inputs[[key]] <- TRUE
    return(list(accepted = TRUE))
  }

  list(accepted = FALSE, error = "No pending input request")
}

#' Handle POST /input/cancel
#' @keywords internal
handle_input_cancel <- function(body) {
  session_id <- body$session %||% "default"
  exec_id <- body$exec_id

  if (is.null(exec_id)) {
    return(list(cancelled = FALSE, error = "exec_id is required", status = 400L))
  }

  key <- paste(session_id, exec_id, sep = ":")
  if (key %in% names(.mrp_env$pending_inputs)) {
    .mrp_env$pending_inputs[[key]] <- NULL
    .mrp_env$input_values[[key]] <- NULL
    return(list(cancelled = TRUE))
  }

  list(cancelled = FALSE, error = "No pending input request")
}

#' Handle POST /interrupt
#' @keywords internal
handle_interrupt <- function(body) {
  session_id <- body$session %||% "default"
  session <- .mrp_env$sessions[[session_id]]

  if (is.null(session)) {
    return(list(interrupted = FALSE, error = "Session not found", status = 404L))
  }

  # Set interrupt flag
  session$interrupted <- TRUE

  list(interrupted = TRUE)
}
