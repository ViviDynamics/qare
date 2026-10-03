// Fetch a page and say whether it carries a text: the check the example plan
// runs from beside qare, against the port the run published the app on.
const [url, text] = process.argv.slice(2)
const response = await globalThis.fetch(url)
const body = await response.text()
console.log(response.status, body.includes(text) ? 'found' : 'missing')
process.exit(response.ok && body.includes(text) ? 0 : 1)
