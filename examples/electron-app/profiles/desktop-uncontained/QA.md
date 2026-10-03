# QA: the greeter, as a desktop build

The greeter is a small Electron application. Its first window shows a form:
a name, a greeting to choose, and a button that shows the greeting below the
form. A second button opens the details in a window of their own.

There is nothing to log in to and nothing to boot. The run launches the
packaged build named in `config.yml` and drives its windows; a flow opens the
application's pages by path, and `/` is the page the first window loads.
