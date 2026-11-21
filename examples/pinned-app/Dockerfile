# An app on busybox that reaches its database at a pinned address and its
# billing vendor by the vendor's own host name as it starts (#408), and is
# seeded from that database once it is up.
FROM busybox:1.36
COPY site /site
COPY start.sh /start.sh
COPY seed.sh /seed.sh
CMD ["sh", "/start.sh"]
