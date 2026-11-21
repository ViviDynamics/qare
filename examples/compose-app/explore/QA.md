# QA for compose-app, planned against the running app

The same app as `../.qa`, under a profile that says `explore: base`. It
exists so qare's own CI can run the plan job's exploration steps for real
(#377): the base app is booted, a browser is served beside it over the
exploration channel, and a plan names only elements that page showed.
