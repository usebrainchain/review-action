# Changelog

## 1.4.4

The comment on the pull request records the order before the payment is sent, so a re-run for the same commit follows that order and pays nothing.

Versions up to 1.4.3 posted the status before paying and added the order after. If GitHub saved the first write but not the second, the comment names the commit but no order. A run for that commit now stops without paying, and its log says how to find the earlier order or start a new review.
