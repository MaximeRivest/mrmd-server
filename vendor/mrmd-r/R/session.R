#' Session Management
#'
#' Functions for managing R sessions (environments).

#' Create a new session
#' @param session_id Session identifier
#' @return Session object (list)
#' @keywords internal
create_session <- function(session_id) {
  # Create isolated environment with globalenv as parent
  # This allows access to base R functions while isolating user variables

  env <- new.env(parent = globalenv())

  # Set working directory in the session
  env$.mrmd_cwd <- .mrp_env$cwd

  list(
    id = session_id,
    env = env,
    execution_count = 0L,
    created = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    last_activity = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    history = list(),
    current_exec_id = NULL,
    interrupted = FALSE
  )
}

#' Get or create a session
#' @param session_id Session identifier (default: "default")
#' @return Session object
#' @keywords internal
get_or_create_session <- function(session_id = "default") {
  if (!(session_id %in% names(.mrp_env$sessions))) {
    .mrp_env$sessions[[session_id]] <- create_session(session_id)
  }
  .mrp_env$sessions[[session_id]]
}

#' Update session activity timestamp
#' @keywords internal
touch_session <- function(session) {
  session$last_activity <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
  session
}

#' Shutdown all sessions
#' @keywords internal
shutdown_all_sessions <- function() {
  for (session_id in names(.mrp_env$sessions)) {
    # Clean up any resources
    session <- .mrp_env$sessions[[session_id]]
    # Close any open graphics devices for this session
    # (In practice, each execution closes its own devices)
  }
  .mrp_env$sessions <- list()
}
