# A page and a health file behind busybox's httpd: the smallest app that is
# still built from the tree and answers over HTTP.
FROM busybox:1.36
COPY site /site
CMD ["httpd", "-f", "-p", "3000", "-h", "/site"]
