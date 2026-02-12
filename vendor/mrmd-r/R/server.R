#' MRP Server for R
#'
#' HTTP server implementing the MRP (MRMD Runtime Protocol) for R.
#'
#' @import httpuv
#' @import jsonlite
#' @import later
#' @importFrom evaluate evaluate

# Global state
.mrp_env <- new.env(parent = emptyenv())
.mrp_env$sessions <- list()
.mrp_env$pending_inputs <- list()
.mrp_env$input_values <- list()

#' Start the MRP server
#'
#' @param host Host to bind to (default: "127.0.0.1")
#' @param port Port to bind to (default: 8001)
#' @param cwd Working directory for R sessions (default: getwd())
#' @param blocking If TRUE, block until server is stopped (default: TRUE)
#' @export
start_server <- function(host = "127.0.0.1", port = 8001, cwd = getwd(), blocking = TRUE) {
  .mrp_env$cwd <- normalizePath(cwd, mustWork = FALSE)
  .mrp_env$r_version <- paste(R.version$major, R.version$minor, sep = ".")
  .mrp_env$r_executable <- file.path(R.home("bin"), "R")

  message(sprintf("Starting mrmd-r server..."))
  message(sprintf("  Host: %s", host))
  message(sprintf("  Port: %d", port))
  message(sprintf("  Working directory: %s", .mrp_env$cwd))
  message(sprintf("  URL: http://%s:%d/mrp/v1/capabilities", host, port))

  app <- list(
    call = function(req) {
      route_request(req)
    }
  )

  server <- httpuv::startServer(host, port, app)
  .mrp_env$server <- server

  message("\nServer started. Press Ctrl+C to stop.")


  if (blocking) {
    on.exit({
      message("\nShutting down...")
      shutdown_all_sessions()
      httpuv::stopServer(server)
    })

    # Run the event loop
    while (TRUE) {
      later::run_now(timeoutSecs = 1)
      Sys.sleep(0.01)
    }
  }

  invisible(server)
}

#' Stop the MRP server
#' @export
stop_server <- function() {
  if (!is.null(.mrp_env$server)) {
    shutdown_all_sessions()
    httpuv::stopServer(.mrp_env$server)
    .mrp_env$server <- NULL
    message("Server stopped.")
  }
}

#' Route incoming HTTP requests
#' @keywords internal
route_request <- function(req) {
  path <- req$PATH_INFO
  method <- req$REQUEST_METHOD

  # Parse JSON body for POST requests
  body <- NULL
  if (method == "POST" && !is.null(req$rook.input)) {
    body_raw <- req$rook.input$read_lines()
    if (length(body_raw) > 0 && nchar(body_raw) > 0) {
      body <- tryCatch(
        jsonlite::fromJSON(body_raw, simplifyVector = FALSE),
        error = function(e) list()
      )
    }
  }

  # CORS headers for all responses
  cors_headers <- list(
    "Access-Control-Allow-Origin" = "*",
    "Access-Control-Allow-Methods" = "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers" = "Content-Type"
  )

  # Handle CORS preflight

  if (method == "OPTIONS") {
    return(list(
      status = 204L,
      headers = cors_headers,
      body = ""
    ))
  }

  # Route to handlers
  result <- tryCatch({
    if (path == "/mrp/v1/capabilities" && method == "GET") {
      handle_capabilities()
    } else if (path == "/mrp/v1/sessions" && method == "GET") {
      handle_list_sessions()
    } else if (path == "/mrp/v1/sessions" && method == "POST") {
      handle_create_session(body)
    } else if (grepl("^/mrp/v1/sessions/[^/]+$", path) && method == "GET") {
      session_id <- sub("^/mrp/v1/sessions/", "", path)
      handle_get_session(session_id)
    } else if (grepl("^/mrp/v1/sessions/[^/]+$", path) && method == "DELETE") {
      session_id <- sub("^/mrp/v1/sessions/", "", path)
      handle_delete_session(session_id)
    } else if (grepl("^/mrp/v1/sessions/[^/]+/reset$", path) && method == "POST") {
      session_id <- sub("^/mrp/v1/sessions/([^/]+)/reset$", "\\1", path)
      handle_reset_session(session_id)
    } else if (path == "/mrp/v1/execute" && method == "POST") {
      handle_execute(body)
    } else if (path == "/mrp/v1/execute/stream" && method == "POST") {
      return(handle_execute_stream(body, cors_headers))
    } else if (path == "/mrp/v1/input" && method == "POST") {
      handle_input(body)
    } else if (path == "/mrp/v1/input/cancel" && method == "POST") {
      handle_input_cancel(body)
    } else if (path == "/mrp/v1/interrupt" && method == "POST") {
      handle_interrupt(body)
    } else if (path == "/mrp/v1/complete" && method == "POST") {
      handle_complete(body)
    } else if (path == "/mrp/v1/inspect" && method == "POST") {
      handle_inspect(body)
    } else if (path == "/mrp/v1/hover" && method == "POST") {
      handle_hover(body)
    } else if (path == "/mrp/v1/variables" && method == "POST") {
      handle_variables(body)
    } else if (grepl("^/mrp/v1/variables/", path) && method == "POST") {
      var_name <- sub("^/mrp/v1/variables/", "", path)
      handle_variable_detail(var_name, body)
    } else if (path == "/mrp/v1/is_complete" && method == "POST") {
      handle_is_complete(body)
    } else if (path == "/mrp/v1/format" && method == "POST") {
      handle_format(body)
    } else if (grepl("^/mrp/v1/assets/", path) && method == "GET") {
      asset_path <- sub("^/mrp/v1/assets/", "", path)
      handle_assets(asset_path)
    } else {
      list(error = "Not found", status = 404L)
    }
  }, error = function(e) {
    list(error = conditionMessage(e), status = 500L)
  })

  # Build response
  status <- if (!is.null(result$status)) result$status else 200L
  result$status <- NULL

  # Check if this is a raw binary response (e.g., assets)
  if (isTRUE(result$raw)) {
    # Return binary data directly
    headers <- c(cors_headers, result$headers)
    return(list(
      status = status,
      headers = headers,
      body = result$body
    ))
  }

  # Default: JSON response
  headers <- c(cors_headers, list("Content-Type" = "application/json"))

  list(
    status = status,
    headers = headers,
    body = jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")
  )
}

#' Handle GET /capabilities
#' @keywords internal
handle_capabilities <- function() {
  list(
    runtime = "r",
    version = .mrp_env$r_version,
    languages = list("r", "R", "rlang"),
    features = list(
      execute = TRUE,
      executeStream = TRUE,
      interrupt = TRUE,
      complete = TRUE,
      inspect = TRUE,
      hover = TRUE,
      variables = TRUE,
      variableExpand = TRUE,
      reset = TRUE,
      isComplete = TRUE,
      format = FALSE,
      assets = TRUE
    ),
    lspFallback = NULL,
    defaultSession = "default",
    maxSessions = 10L,
    environment = list(
      cwd = .mrp_env$cwd,
      executable = .mrp_env$r_executable,
      shell = NULL
    )
  )
}

#' Handle GET /sessions
#' @keywords internal
handle_list_sessions <- function() {
  sessions_info <- lapply(names(.mrp_env$sessions), function(id) {
    session <- .mrp_env$sessions[[id]]
    list(
      id = id,
      language = "r",
      created = session$created,
      lastActivity = session$last_activity,
      executionCount = session$execution_count,
      variableCount = length(ls(session$env))
    )
  })
  list(sessions = sessions_info)
}

#' Handle POST /sessions
#' @keywords internal
handle_create_session <- function(body) {
  session_id <- body$id %||% sprintf("session-%s", as.numeric(Sys.time()))

  if (session_id %in% names(.mrp_env$sessions)) {
    return(list(error = sprintf("Session %s already exists", session_id), status = 409L))
  }

  session <- create_session(session_id)
  .mrp_env$sessions[[session_id]] <- session

  list(
    id = session_id,
    language = "r",
    created = session$created,
    lastActivity = session$last_activity,
    executionCount = 0L,
    variableCount = 0L,
    status = 201L
  )
}

#' Handle GET /sessions/{id}
#' @keywords internal
handle_get_session <- function(session_id) {
  session <- .mrp_env$sessions[[session_id]]
  if (is.null(session)) {
    return(list(error = sprintf("Session %s not found", session_id), status = 404L))
  }

  list(
    id = session_id,
    language = "r",
    created = session$created,
    lastActivity = session$last_activity,
    executionCount = session$execution_count,
    variableCount = length(ls(session$env))
  )
}

#' Handle DELETE /sessions/{id}
#' @keywords internal
handle_delete_session <- function(session_id) {
  if (!(session_id %in% names(.mrp_env$sessions))) {
    return(list(error = sprintf("Session %s not found", session_id), status = 404L))
  }

  .mrp_env$sessions[[session_id]] <- NULL
  list(deleted = TRUE)
}

#' Handle POST /sessions/{id}/reset
#' @keywords internal
handle_reset_session <- function(session_id) {
  session <- .mrp_env$sessions[[session_id]]
  if (is.null(session)) {
    return(list(error = sprintf("Session %s not found", session_id), status = 404L))
  }

  # Create fresh environment
  session$env <- new.env(parent = globalenv())
  session$execution_count <- 0L
  session$last_activity <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")

  list(reset = TRUE)
}

# Null-coalescing operator
`%||%` <- function(a, b) if (is.null(a)) b else a
