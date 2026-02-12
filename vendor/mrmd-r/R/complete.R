#' Code Completion and Introspection
#'
#' Functions for tab completion and symbol inspection.

#' Handle POST /complete
#' @keywords internal
handle_complete <- function(body) {
  code <- body$code %||% ""
  cursor <- body$cursor %||% nchar(code)
  session_id <- body$session %||% "default"

  session <- get_or_create_session(session_id)

  # Extract the text being completed
  text_before <- substr(code, 1, cursor)

  # Find the start of the current token
  # R tokens can contain letters, digits, dots, and underscores
  # Also handle $ for list/data.frame access
  token_pattern <- "[a-zA-Z0-9._$]+"
  matches <- gregexpr(token_pattern, text_before, perl = TRUE)[[1]]

  if (matches[1] == -1) {
    # No token found
    return(list(matches = list(), cursorStart = cursor, cursorEnd = cursor, source = "runtime"))
  }

  # Get the last match (the token at cursor)
  last_match_start <- matches[length(matches)]
  last_match_length <- attr(matches, "match.length")[length(matches)]

  # Check if cursor is at the end of or within this token
  token_end <- last_match_start + last_match_length - 1
  if (cursor < last_match_start || cursor > token_end + 1) {
    # Cursor not at a token
    return(list(matches = list(), cursorStart = cursor, cursorEnd = cursor, source = "runtime"))
  }

  token <- substr(text_before, last_match_start, cursor)
  cursor_start <- last_match_start

  # Get completions
  completions <- get_completions(token, session$env)

  list(
    matches = completions,
    cursorStart = cursor_start - 1,  # 0-indexed
    cursorEnd = cursor - 1,          # 0-indexed
    source = "runtime"
  )
}

#' Get completions for a token
#' @keywords internal
get_completions <- function(token, env) {
  completions <- list()

  # Check if this is a $ accessor (e.g., df$col)
  if (grepl("\\$", token)) {
    parts <- strsplit(token, "\\$", fixed = FALSE)[[1]]
    obj_name <- parts[1]
    prefix <- if (length(parts) > 1) parts[2] else ""

    # Try to get the object
    obj <- tryCatch(get(obj_name, envir = env), error = function(e) NULL)

    if (!is.null(obj)) {
      # Get names/columns
      obj_names <- names(obj)
      if (!is.null(obj_names)) {
        for (name in obj_names) {
          if (startsWith(name, prefix)) {
            completions <- c(completions, list(list(
              label = name,
              insertText = name,
              kind = "field",
              detail = tryCatch(class(obj[[name]])[1], error = function(e) "unknown"),
              documentation = NULL,
              valuePreview = NULL,
              type = "field"
            )))
          }
        }
      }
    }
  } else {
    # Regular completion - search in environment and packages
    all_names <- character(0)

    # Session environment
    all_names <- c(all_names, ls(env))

    # Global environment
    all_names <- c(all_names, ls(globalenv()))

    # Base package
    all_names <- c(all_names, ls("package:base"))

    # Loaded packages
    for (pkg in search()) {
      if (startsWith(pkg, "package:")) {
        all_names <- c(all_names, tryCatch(ls(pkg), error = function(e) character(0)))
      }
    }

    # Unique names
    all_names <- unique(all_names)

    # Filter by prefix
    for (name in all_names) {
      if (startsWith(name, token)) {
        # Determine kind
        obj <- tryCatch(get(name, envir = env), error = function(e) {
          tryCatch(get(name), error = function(e) NULL)
        })

        kind <- "variable"
        detail <- NULL
        if (!is.null(obj)) {
          if (is.function(obj)) {
            kind <- "function"
            # Get function signature
            detail <- tryCatch({
              args <- formals(obj)
              if (length(args) > 0) {
                paste0("(", paste(names(args), collapse = ", "), ")")
              } else {
                "()"
              }
            }, error = function(e) NULL)
          } else if (is.data.frame(obj)) {
            kind <- "variable"
            detail <- sprintf("data.frame [%d x %d]", nrow(obj), ncol(obj))
          } else if (is.list(obj)) {
            kind <- "variable"
            detail <- sprintf("list [%d]", length(obj))
          } else if (is.vector(obj)) {
            kind <- "variable"
            detail <- sprintf("%s [%d]", class(obj)[1], length(obj))
          } else {
            detail <- class(obj)[1]
          }
        }

        completions <- c(completions, list(list(
          label = name,
          insertText = if (kind == "function") paste0(name, "(") else name,
          kind = kind,
          detail = detail,
          documentation = NULL,
          valuePreview = NULL,
          type = kind
        )))
      }
    }
  }

  # Limit results
  if (length(completions) > 50) {
    completions <- completions[1:50]
  }

  completions
}

#' Handle POST /inspect
#' @keywords internal
handle_inspect <- function(body) {
  code <- body$code %||% ""
  cursor <- body$cursor %||% nchar(code)
  session_id <- body$session %||% "default"
  detail_level <- body$detail %||% 0

  session <- get_or_create_session(session_id)

  # Extract symbol at cursor
  symbol <- extract_symbol_at_cursor(code, cursor)

  if (is.null(symbol) || nchar(symbol) == 0) {
    return(list(found = FALSE, source = "runtime"))
  }

  # Try to get the object
  obj <- tryCatch(
    eval(parse(text = symbol), envir = session$env),
    error = function(e) NULL
  )

  if (is.null(obj)) {
    return(list(found = FALSE, source = "runtime"))
  }

  # Build inspection result
  result <- list(
    found = TRUE,
    source = "runtime",
    name = symbol,
    kind = if (is.function(obj)) "function" else "variable",
    type = class(obj)[1]
  )

  if (is.function(obj)) {
    # Function inspection
    result$signature <- tryCatch({
      args <- formals(obj)
      arg_strs <- mapply(function(name, default) {
        if (is.symbol(default) && deparse(default) == "") {
          name
        } else {
          paste0(name, " = ", deparse(default))
        }
      }, names(args), args, USE.NAMES = FALSE)
      paste0("(", paste(arg_strs, collapse = ", "), ")")
    }, error = function(e) NULL)

    if (detail_level >= 1) {
      # Get documentation
      result$docstring <- tryCatch({
        # Try to get help text
        help_file <- help(symbol, help_type = "text")
        if (length(help_file) > 0) {
          # This would require parsing help files - simplified for now
          NULL
        } else {
          NULL
        }
      }, error = function(e) NULL)
    }

    if (detail_level >= 2) {
      # Get source code
      result$sourceCode <- tryCatch({
        src <- deparse(obj)
        paste(src, collapse = "\n")
      }, error = function(e) NULL)
    }
  } else {
    # Variable inspection
    result$value <- tryCatch({
      output <- capture.output(str(obj, max.level = 1))
      paste(output, collapse = "\n")
    }, error = function(e) NULL)
  }

  result
}

#' Handle POST /hover
#' @keywords internal
handle_hover <- function(body) {
  code <- body$code %||% ""
  cursor <- body$cursor %||% nchar(code)
  session_id <- body$session %||% "default"

  session <- get_or_create_session(session_id)

  # Extract symbol at cursor
  symbol <- extract_symbol_at_cursor(code, cursor)

  if (is.null(symbol) || nchar(symbol) == 0) {
    return(list(found = FALSE))
  }

  # Try to get the object
  obj <- tryCatch(
    eval(parse(text = symbol), envir = session$env),
    error = function(e) NULL
  )

  if (is.null(obj)) {
    # Try global
    obj <- tryCatch(get(symbol), error = function(e) NULL)
  }

  if (is.null(obj)) {
    return(list(found = FALSE))
  }

  # Build hover result
  result <- list(
    found = TRUE,
    name = symbol,
    type = class(obj)[1]
  )

  if (is.function(obj)) {
    result$signature <- tryCatch({
      args <- formals(obj)
      if (length(args) > 0) {
        paste0("(", paste(names(args), collapse = ", "), ")")
      } else {
        "()"
      }
    }, error = function(e) NULL)
  } else {
    result$value <- tryCatch({
      if (is.data.frame(obj)) {
        sprintf("<%d rows x %d cols>", nrow(obj), ncol(obj))
      } else if (is.list(obj)) {
        sprintf("list [%d]", length(obj))
      } else if (is.vector(obj) && length(obj) <= 5) {
        paste(capture.output(print(obj)), collapse = " ")
      } else if (is.vector(obj)) {
        sprintf("%s [%d]", class(obj)[1], length(obj))
      } else {
        class(obj)[1]
      }
    }, error = function(e) class(obj)[1])
  }

  result
}

#' Extract symbol at cursor position
#' @keywords internal
extract_symbol_at_cursor <- function(code, cursor) {
  # Find word boundaries around cursor
  # R symbols can contain: letters, digits, dots, underscores
  # Also handle $ for accessors

  before <- substr(code, 1, cursor)
  after <- substr(code, cursor + 1, nchar(code))

  # Find start of symbol (go backwards)
  start_match <- regexpr("[a-zA-Z0-9._$]+$", before, perl = TRUE)
  if (start_match == -1) {
    return(NULL)
  }

  # Find end of symbol (go forwards)
  end_match <- regexpr("^[a-zA-Z0-9._]+", after, perl = TRUE)
  end_length <- if (end_match == -1) 0 else attr(end_match, "match.length")

  symbol_start <- start_match
  symbol <- paste0(
    substr(before, symbol_start, nchar(before)),
    substr(after, 1, end_length)
  )

  symbol
}
