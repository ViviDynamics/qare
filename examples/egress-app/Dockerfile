# An app that reaches for the outside world as it starts (#382), on
# busybox: it fetches its billing vendor by the vendor's real host name,
# tries a vendor no stub stands in for, and dials a literal address. It
# writes what happened to each as a page, then writes the health file last,
# so it is healthy only once all three have been tried.
FROM busybox:1.36
COPY site /site
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
