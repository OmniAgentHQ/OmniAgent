export const OMNIAGENT_TOOL_NAMES = [
  'list_files', 'read_file', 'write_file', 'edit_file', 'copy_file', 'move_file', 'delete_file',
  'make_directory', 'glob_search', 'grep_search', 'open_folder', 'open_terminal', 'run_command',
  'download_file', 'fetch_url', 'web_search', 'open_url', 'open_page', 'open_search_in_browser',
  'write_document', 'create_archive', 'extract_archive', 'take_screenshot', 'read_screen',
  'click_element', 'type_text', 'press_key', 'scroll_page', 'list_windows', 'focus_window',
  'open_app', 'get_datetime'
] as const;

export const TOOL_NAME_PATTERN_SOURCE =
  `(?:${OMNIAGENT_TOOL_NAMES.join('|')}|browser_[a-z_]+)`;

export function mentionsToolName(value: string) {
  return new RegExp(`\\b${TOOL_NAME_PATTERN_SOURCE}\\b`, 'i').test(String(value ?? ''));
}

export const NO_TOOL_NAMES_INSTRUCTION =
  'Never name an internal tool in a step name, description or instruction. The worker is already told which tools it has, and a person reads these words. Write the outcome — "save the report as a PDF in the output folder" — never the mechanism: no "use the write_document tool", no "call download_file", no tool name of any kind.';
