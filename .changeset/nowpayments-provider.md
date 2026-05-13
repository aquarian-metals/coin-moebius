---
'@aquarian-metals/coin-moebius-nowpayments': minor
'@aquarian-metals/coin-moebius-core': minor
'@aquarian-metals/coin-moebius': minor
'@aquarian-metals/coin-moebius-server': minor
'@aquarian-metals/coin-moebius-stripe': minor
'@aquarian-metals/coin-moebius-cryptomus': minor
'@aquarian-metals/coin-moebius-manual': minor
'@aquarian-metals/coin-moebius-element': minor
'@aquarian-metals/coin-moebius-provider-template': minor
---

New package `@aquarian-metals/coin-moebius-nowpayments` adds a US-friendly crypto provider (Cryptomus' API is geo-blocked in the US). Includes the hosted-invoice flow on the client side and an IPN webhook verifier (HMAC-SHA512 over recursively-sorted JSON, header `x-nowpayments-sig`) on the server. Cryptomus stays published for international consumers.
