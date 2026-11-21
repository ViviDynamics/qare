# QA for egress-app

An app that reaches for the outside world as it starts, booted with compose
beside one stub. It exists so qare's own CI proves a booted stack is
contained (#382): the declared stub answers by the vendor's own host name,
a vendor no stub declares is blocked and listed in the evidence, and a
literal address has no route.

- Health: `/up` answers 200 once the app has tried all three.
- `/billing.txt`: what the billing stub answered, or `unreached`.
- `/undeclared.txt`: `blocked` or `reached`, for the undeclared vendor.
- `/address.txt`: `blocked` or `reached`, for a literal address.
