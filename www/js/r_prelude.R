# r_prelude.R — R prelude for SciREPL
#
# SharedVFS convenience functions and interactive plotting.
# Loaded into the webR session during init().

# ── SharedVFS helpers ─────────────────────────────────────────
# These operate on /shared/ and /tmp/ paths which are synced
# between webR's filesystem and the SharedVFS before/after
# each cell execution.

#' Read a text file from the shared filesystem.
sharedfs_read <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  paste(readLines(path, warn = FALSE), collapse = "\n")
}

#' Write text to a file in the shared filesystem.
sharedfs_write <- function(path, content) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  writeLines(as.character(content), path)
  invisible(path)
}

#' Check if a file or directory exists in the shared filesystem.
sharedfs_exists <- function(path) {
  file.exists(path)
}

#' List files in a shared directory.
sharedfs_list <- function(path = "/shared") {
  if (!dir.exists(path)) stop(paste("Directory not found:", path))
  list.files(path, full.names = FALSE)
}

#' Remove a file from the shared filesystem.
sharedfs_remove <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  file.remove(path)
  invisible(TRUE)
}

#' Get file size in bytes.
sharedfs_size <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  file.info(path)$size
}

# ── Interactive Plotly plotting ────────────────────────────────
# Emits Plotly JSON markers that the R kernel intercepts and
# routes to Plotly.js for interactive charts.

# Simple JSON builder (no jsonlite dependency)
.to_json_array <- function(x) {
  paste0("[", paste(x, collapse = ","), "]")
}

.to_json_string <- function(s) {
  if (nchar(s) == 0) return('""')
  # Escape backslashes and quotes
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub('"', '\\\\"', s)
  paste0('"', s, '"')
}

#' Create an interactive Plotly chart.
#'
#' @param x Numeric vector (or indices if y is NULL)
#' @param y Numeric vector (optional, x used as y if NULL)
#' @param title Plot title
#' @param xlabel X-axis label
#' @param ylabel Y-axis label
#' @param type Plotly trace type ("scatter", "bar", etc.)
#' @param mode Plotly mode ("lines", "markers", "lines+markers")
#' @param name Legend name
#'
#' @examples
#' plotly(1:10, (1:10)^2, title = "Quadratic")
#' plotly(sin(seq(0, 2*pi, length.out = 100)))
plotly <- function(x, y = NULL, title = "", xlabel = "", ylabel = "",
                   type = "scatter", mode = "lines+markers", name = "") {
  if (is.null(y)) {
    y_data <- as.numeric(x)
    x_data <- seq_along(x)
  } else {
    x_data <- as.numeric(x)
    y_data <- as.numeric(y)
  }

  json <- paste0(
    '{',
    '"x":', .to_json_array(x_data), ',',
    '"y":', .to_json_array(y_data), ',',
    '"title":', .to_json_string(title), ',',
    '"xlabel":', .to_json_string(xlabel), ',',
    '"ylabel":', .to_json_string(ylabel), ',',
    '"name":', .to_json_string(name), ',',
    '"type":', .to_json_string(type), ',',
    '"mode":', .to_json_string(mode),
    '}'
  )

  cat("__SCIREPL_PLOTLY__", json, "__END_PLOTLY__\n")
  invisible(NULL)
}

#' Create multi-trace Plotly chart.
#'
#' @param ... Named arguments: x, y vectors and trace options
#' @param traces List of trace lists, each with x, y, name, type, mode
#' @param title Plot title
#' @param xlabel X-axis label
#' @param ylabel Y-axis label
#'
#' @examples
#' mplotly(
#'   traces = list(
#'     list(x = 1:10, y = (1:10)^2, name = "quadratic"),
#'     list(x = 1:10, y = 1:10, name = "linear")
#'   ),
#'   title = "Comparison"
#' )
mplotly <- function(traces, title = "", xlabel = "", ylabel = "") {
  trace_jsons <- sapply(traces, function(t) {
    x_data <- as.numeric(t$x)
    y_data <- as.numeric(t$y)
    paste0(
      '{',
      '"x":', .to_json_array(x_data), ',',
      '"y":', .to_json_array(y_data), ',',
      '"name":', .to_json_string(t$name %||% ""), ',',
      '"type":', .to_json_string(t$type %||% "scatter"), ',',
      '"mode":', .to_json_string(t$mode %||% "lines"),
      '}'
    )
  })

  json <- paste0(
    '{',
    '"traces":[', paste(trace_jsons, collapse = ","), '],',
    '"title":', .to_json_string(title), ',',
    '"xlabel":', .to_json_string(xlabel), ',',
    '"ylabel":', .to_json_string(ylabel),
    '}'
  )

  cat("__SCIREPL_PLOTLY__", json, "__END_PLOTLY__\n")
  invisible(NULL)
}
