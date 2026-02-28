# r_sharedfs.R — R convenience functions for SharedVFS access
#
# These functions operate on /shared/ and /tmp/ paths which are
# synced between webR's filesystem and the SharedVFS before/after
# each cell execution. Files written here become visible to
# Python, Bash, Prolog, and JavaScript kernels.

#' Read a text file from the shared filesystem.
#' @param path Character string, e.g. "/shared/data/myfile.txt"
#' @return Character string with file contents
sharedfs_read <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  paste(readLines(path, warn = FALSE), collapse = "\n")
}

#' Write text to a file in the shared filesystem.
#' @param path Character string, e.g. "/shared/data/output.txt"
#' @param content Character string to write
sharedfs_write <- function(path, content) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  writeLines(as.character(content), path)
  invisible(path)
}

#' Check if a file or directory exists in the shared filesystem.
#' @param path Character string
#' @return Logical
sharedfs_exists <- function(path) {
  file.exists(path)
}

#' List files in a shared directory.
#' @param path Character string, defaults to "/shared"
#' @return Character vector of file/directory names
sharedfs_list <- function(path = "/shared") {
  if (!dir.exists(path)) stop(paste("Directory not found:", path))
  list.files(path, full.names = FALSE)
}

#' Remove a file from the shared filesystem.
#' @param path Character string
sharedfs_remove <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  file.remove(path)
  invisible(TRUE)
}

#' Get file size in bytes.
#' @param path Character string
#' @return Numeric file size
sharedfs_size <- function(path) {
  if (!file.exists(path)) stop(paste("File not found:", path))
  file.info(path)$size
}
