# Trikey Guardian

Trikey is a 2-of-3 bitcoin wallet in which every key is yours: a hardware wallet, your phone, and
this guardian on your own server. The guardian is the third key. It co-signs your phone's payments
under a daily limit you set, and it runs a Delay & Notify recovery if you lose your phone.

## Before you start

Trikey Guardian needs **Bitcoin** and **Electrs** installed and running. Electrs needs an archival
(unpruned) Bitcoin node; StartOS will ask you to set that up when you install Electrs. Scanning for
silent payments reads whole blocks from your node, so let Bitcoin and Electrs finish syncing first.

## Set up

1. Run the **Set Web UI Password** action. Copy the password: it is shown once. (Run the action again
   at any time to get a new one.)
2. Start the service and open **Web UI**. Your browser asks for the username `admin` and that password.
3. In the guardian's own screen, choose the nostr relays, and choose a **passphrase for key 3**. The
   guardian encrypts key 3 with it, and asks for it every time it starts. **Nobody can recover it
   for you.**
4. In the Trikey app on your phone, scan the pairing code the guardian shows.

## Two different passwords

- The **web UI password** (username `admin`) only keeps other people on your network out of the
  guardian's screen. It is set by the StartOS action.
- The **passphrase for key 3** unlocks the key. You choose it in the guardian's screen. It is never
  stored anywhere, and after every restart the guardian is locked until you or your phone unlock it.

## Backups

StartOS backups **do not include the guardian**, by design. Trikey keeps no backup of key 3: if this
server is lost, your phone and hardware wallet move your coins to a new wallet with a new guardian
("Replace guardian" in the app). A restored copy of old guardian state could also be wrong about how
much you spent today. Keep your hardware wallet and your phone's recovery code safe instead.

## Network use

The guardian talks to your own Bitcoin and Electrs, and to the nostr relays you chose (to reach your
phone and send alerts). It does not accept connections other than to its web interface.

## Documentation

- [Trikey on GitHub](https://github.com/TheIcarusWings/trikey)
- [How to check that the guardian is the published code](https://github.com/TheIcarusWings/trikey/blob/main/packaging/VERIFY.md)
