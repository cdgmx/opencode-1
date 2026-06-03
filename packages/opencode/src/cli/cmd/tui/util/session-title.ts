const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function isDefaultSessionTitle(title: string) {
  return new RegExp(`^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`).test(title)
}
