#' Variable Inspection
#'
#' Functions for listing and inspecting session variables.

#' Handle POST /variables
#' @keywords internal
handle_variables <- function(body) {
  session_id <- body$session %||% "default"
  filter <- body$filter %||% list()

  session <- get_or_create_session(session_id)

  # Get all variables in session environment
  var_names <- ls(session$env, all.names = FALSE)

  # Apply filters
  if (!is.null(filter$excludePrivate) && filter$excludePrivate) {
    var_names <- var_names[!startsWith(var_names, ".")]
  }

  if (!is.null(filter$namePattern)) {
    pattern <- filter$namePattern
    var_names <- var_names[grepl(pattern, var_names, perl = TRUE)]
  }

  if (!is.null(filter$types)) {
    allowed_types <- unlist(filter$types)
    var_names <- Filter(function(name) {
      obj <- get(name, envir = session$env)
      class(obj)[1] %in% allowed_types
    }, var_names)
  }

  # Build variable list
  variables <- lapply(var_names, function(name) {
    obj <- get(name, envir = session$env)
    build_variable_info(name, obj)
  })

  # Limit results
  truncated <- length(variables) > 200
  if (truncated) {
    variables <- variables[1:200]
  }

  list(
    variables = variables,
    count = length(variables),
    truncated = truncated
  )
}

#' Handle POST /variables/{name}
#' @keywords internal
handle_variable_detail <- function(var_name, body) {
  session_id <- body$session %||% "default"
  path <- body$path %||% list()
  max_children <- body$maxChildren %||% 100
  max_value_length <- body$maxValueLength %||% 1000

  session <- get_or_create_session(session_id)

  # Get the base variable
  if (!exists(var_name, envir = session$env)) {
    return(list(
      name = var_name,
      type = "undefined",
      value = "",
      expandable = FALSE
    ))
  }

  obj <- get(var_name, envir = session$env)

  # Navigate path
  for (key in path) {
    obj <- tryCatch({
      if (is.list(obj) || is.environment(obj)) {
        obj[[key]]
      } else if (is.data.frame(obj)) {
        if (key %in% names(obj)) {
          obj[[key]]
        } else if (grepl("^[0-9]+$", key)) {
          obj[as.integer(key), ]
        } else {
          NULL
        }
      } else if (is.vector(obj) && grepl("^[0-9]+$", key)) {
        obj[as.integer(key)]
      } else {
        NULL
      }
    }, error = function(e) NULL)

    if (is.null(obj)) {
      return(list(
        name = key,
        type = "undefined",
        value = "",
        expandable = FALSE
      ))
    }
  }

  # Build detailed info
  full_name <- if (length(path) > 0) {
    paste(c(var_name, unlist(path)), collapse = "$")
  } else {
    var_name
  }

  # Get full value representation
  full_value <- tryCatch({
    output <- capture.output(print(obj))
    paste(output, collapse = "\n")
  }, error = function(e) "")

  if (nchar(full_value) > max_value_length) {
    full_value <- paste0(substr(full_value, 1, max_value_length), "...")
  }

  # Get children
  children <- NULL
  if (is_expandable(obj)) {
    children <- get_children(obj, max_children)
  }

  # Get methods (for S3/S4 objects)
  methods <- NULL
  obj_class <- class(obj)[1]
  if (!obj_class %in% c("numeric", "integer", "character", "logical", "list", "data.frame")) {
    methods <- tryCatch({
      # Find methods for this class
      method_names <- methods(class = obj_class)
      if (length(method_names) > 0) {
        as.character(method_names)[1:min(10, length(method_names))]
      } else {
        NULL
      }
    }, error = function(e) NULL)
  }

  # Get attributes
  attributes <- names(attributes(obj))

  list(
    name = full_name,
    type = class(obj)[1],
    value = format_value_short(obj),
    size = format_size(obj),
    expandable = is_expandable(obj),
    length = if (is.vector(obj) || is.list(obj)) length(obj) else NULL,
    fullValue = full_value,
    children = children,
    methods = methods,
    attributes = attributes,
    truncated = !is.null(children) && length(children) >= max_children
  )
}

#' Build basic variable info
#' @keywords internal
build_variable_info <- function(name, obj) {
  list(
    name = name,
    type = class(obj)[1],
    value = format_value_short(obj),
    size = format_size(obj),
    expandable = is_expandable(obj),
    shape = if (is.matrix(obj) || is.data.frame(obj)) as.list(dim(obj)) else NULL,
    dtype = if (is.vector(obj)) typeof(obj) else NULL,
    length = if (is.vector(obj) || is.list(obj)) length(obj) else NULL,
    keys = if (is.list(obj) && !is.null(names(obj))) names(obj)[1:min(10, length(names(obj)))] else NULL
  )
}

#' Format a short value representation
#' @keywords internal
format_value_short <- function(obj, max_length = 100) {
  value <- tryCatch({
    if (is.data.frame(obj)) {
      sprintf("<%d rows x %d cols>", nrow(obj), ncol(obj))
    } else if (is.matrix(obj)) {
      sprintf("<%d x %d %s>", nrow(obj), ncol(obj), typeof(obj))
    } else if (is.list(obj)) {
      sprintf("{...} (%d items)", length(obj))
    } else if (is.function(obj)) {
      "<function>"
    } else if (is.environment(obj)) {
      "<environment>"
    } else if (is.vector(obj) && length(obj) <= 5) {
      output <- capture.output(cat(obj, sep = ", "))
      paste(output, collapse = "")
    } else if (is.vector(obj)) {
      sprintf("[%d] %s...", length(obj), paste(head(obj, 3), collapse = ", "))
    } else {
      output <- capture.output(print(obj, max.level = 0))
      paste(output[1], collapse = "")
    }
  }, error = function(e) class(obj)[1])

  if (nchar(value) > max_length) {
    value <- paste0(substr(value, 1, max_length - 3), "...")
  }

  value
}

#' Format size information
#' @keywords internal
format_size <- function(obj) {
  tryCatch({
    size <- object.size(obj)
    if (size < 1024) {
      sprintf("%d bytes", size)
    } else if (size < 1024 * 1024) {
      sprintf("%.1f KB", size / 1024)
    } else {
      sprintf("%.1f MB", size / 1024 / 1024)
    }
  }, error = function(e) NULL)
}

#' Check if object is expandable
#' @keywords internal
is_expandable <- function(obj) {
  is.list(obj) || is.data.frame(obj) || is.environment(obj) ||
    (is.vector(obj) && length(obj) > 1 && !is.character(obj)) ||
    (!is.null(names(obj)))
}

#' Get children of an object
#' @keywords internal
get_children <- function(obj, max_children = 100) {
  children <- list()

  if (is.data.frame(obj)) {
    # Show columns
    col_names <- names(obj)[1:min(max_children, ncol(obj))]
    for (col in col_names) {
      children <- c(children, list(build_variable_info(col, obj[[col]])))
    }
  } else if (is.list(obj)) {
    # Show list elements
    if (!is.null(names(obj))) {
      elem_names <- names(obj)[1:min(max_children, length(obj))]
      for (name in elem_names) {
        children <- c(children, list(build_variable_info(name, obj[[name]])))
      }
    } else {
      for (i in 1:min(max_children, length(obj))) {
        children <- c(children, list(build_variable_info(as.character(i), obj[[i]])))
      }
    }
  } else if (is.environment(obj)) {
    env_names <- ls(obj)[1:min(max_children, length(ls(obj)))]
    for (name in env_names) {
      children <- c(children, list(build_variable_info(name, get(name, envir = obj))))
    }
  } else if (is.vector(obj) && length(obj) > 1) {
    for (i in 1:min(max_children, length(obj))) {
      children <- c(children, list(list(
        name = as.character(i),
        type = typeof(obj),
        value = as.character(obj[i]),
        expandable = FALSE
      )))
    }
  }

  children
}
