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

# ── Notebook VFS helpers (/nb/) ────────────────────────────────
# Read cell properties synced from NotebookVFS before execution.
# Paths: /nb/In[1]/.code, /nb/my_cell/.output, etc.

#' Read a cell property from the notebook.
#' @param cell Cell identifier: "In[1]", "In[2]", or a named cell
#' @param prop Property: ".code", ".output", ".language", ".type", ".name"
nb_read <- function(cell, prop = ".code") {
  path <- paste0("/nb/", cell, "/", prop)
  if (!file.exists(path)) stop(paste("Cell not found:", cell))
  paste(readLines(path, warn = FALSE), collapse = "\n")
}

#' Write a cell property in the notebook.
#' Changes are synced back to NotebookVFS after execution.
#' @param cell Cell identifier: "In[1]", "In[2]", or a named cell
#' @param prop Property: ".code", ".language", ".type", ".name"
#' @param value New value (character string)
nb_write <- function(cell, prop, value) {
  path <- paste0("/nb/", cell, "/", prop)
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  writeLines(as.character(value), path)
  invisible(path)
}

#' List cells in the notebook (reads synced /nb/ directory).
nb_list <- function() {
  if (!dir.exists("/nb")) return(character(0))
  list.files("/nb", full.names = FALSE)
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

# ── ggplot2 Dark Theme ──────────────────────────────────────
# Auto-applied when ggplot2 is loaded. Matches the app's
# GitHub-dark color scheme.

#' SciREPL dark theme for ggplot2.
theme_scirepl <- function(base_size = 12) {
  if (!requireNamespace("ggplot2", quietly = TRUE)) {
    stop("ggplot2 is required for theme_scirepl()")
  }
  ggplot2::theme_minimal(base_size = base_size) +
    ggplot2::theme(
      # Canvas
      plot.background    = ggplot2::element_rect(fill = "#0d1117", colour = NA),
      panel.background   = ggplot2::element_rect(fill = "#161b22", colour = NA),
      # Grid
      panel.grid.major   = ggplot2::element_line(colour = "#30363d", linewidth = 0.3),
      panel.grid.minor   = ggplot2::element_line(colour = "#21262d", linewidth = 0.2),
      # Axes
      axis.text          = ggplot2::element_text(colour = "#8b949e"),
      axis.title         = ggplot2::element_text(colour = "#c9d1d9"),
      axis.ticks         = ggplot2::element_line(colour = "#484f58"),
      # Titles
      plot.title         = ggplot2::element_text(colour = "#e6edf3", face = "bold"),
      plot.subtitle      = ggplot2::element_text(colour = "#8b949e"),
      plot.caption       = ggplot2::element_text(colour = "#6e7681"),
      # Legend
      legend.background  = ggplot2::element_rect(fill = "#0d1117", colour = NA),
      legend.text        = ggplot2::element_text(colour = "#c9d1d9"),
      legend.title       = ggplot2::element_text(colour = "#e6edf3"),
      legend.key         = ggplot2::element_rect(fill = "#161b22", colour = NA),
      # Strip (facets)
      strip.background   = ggplot2::element_rect(fill = "#21262d", colour = NA),
      strip.text         = ggplot2::element_text(colour = "#e6edf3"),
      # Margin
      plot.margin        = ggplot2::margin(10, 10, 10, 10)
    )
}

#' Set up ggplot2 with SciREPL dark theme and color defaults.
#' Called automatically when ggplot2 is detected.
.scirepl_setup_ggplot2 <- function() {
  if (!requireNamespace("ggplot2", quietly = TRUE)) return(invisible(NULL))
  ggplot2::theme_set(theme_scirepl())
  # Set default discrete colour palette (vibrant on dark)
  options(
    ggplot2.discrete.colour = c("#58a6ff", "#f0883e", "#a371f7",
                                "#3fb950", "#f85149", "#79c0ff",
                                "#d2a8ff", "#56d364"),
    ggplot2.discrete.fill   = c("#58a6ff", "#f0883e", "#a371f7",
                                "#3fb950", "#f85149", "#79c0ff",
                                "#d2a8ff", "#56d364")
  )
  invisible(TRUE)
}
