// English only for now. Other locales fall back to en_US.
export const short = {
  en_US: 'Key 3 of a 2-of-3 bitcoin wallet, on your own server',
}

export const long = {
  en_US:
    'Trikey is a 2-of-3 bitcoin wallet in which every key is yours: a hardware wallet, your phone, and a guardian on your own server. ' +
    'Trikey Guardian is the third key. It co-signs phone payments under a daily limit you set, and it runs a Delay & Notify recovery if you lose your phone. ' +
    'It uses your own Bitcoin node and Electrs, opens no inbound ports other than its web interface, and holds its key only in memory while unlocked.',
}
