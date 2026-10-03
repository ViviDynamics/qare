// The renderer both halves of the example run (#72): the browser is served
// these files over HTTP, and the desktop build loads them from its bundle.
const form = document.getElementById('greeter')
if (form !== null) {
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = document.getElementById('name').value
    const greeting = document.getElementById('greeting').value
    document.getElementById('shown').textContent = `${greeting}, ${name}.`
    console.log(`renderer: greeted ${name}`)
    // What a careless application does with a credential (#78): it logs it.
    // The greeting above is made of the name alone, so the code is on the
    // page only in the field it was typed into.
    const code = document.getElementById('code').value
    if (code !== '') console.log(`renderer: access code ${code}`)
  })
  document.getElementById('details').addEventListener('click', () => {
    console.log('renderer: opening the details window')
    window.open('details.html', 'details')
  })
}
const close = document.getElementById('close')
if (close !== null) {
  console.log('renderer: details window ready')
  close.addEventListener('click', () => window.close())
}
