"""Signal filtering demo (features 2-5 and 7).

Board A sends three kinds of traffic: text, strong/weak pings, and a
serialised function call. Board B logs only what passes its filters.

Run on the receiver; set ROLE to "sender" on the other board.
"""

from microbit import *
import ultra_expansion as ultra

ROLE = "receiver"        # "receiver" or "sender"
GROUP = 3

ultra.start(group=GROUP)


def sender():
    ultra.set_id(1)
    display.show(Image.ARROW_N)
    while True:
        ultra.send_message("ping from base")
        ultra.send_command(103)
        ultra.send_function("flash", 2, 150)   # flash 2 times, 150 ms
        sleep(1500)


def receiver():
    ultra.set_id(2)

    # Features 2 and 4: board 1 only, and nothing too weak or too far away.
    ultra.set_sender_filter([1])
    ultra.set_signal_threshold(-80)

    ultra.register_function("flash", lambda times=1, delay=100: flash(times, delay))

    @ultra.on_message
    def any_message(msg):
        # Feature 3: RSSI of this packet in dBm.
        display.scroll("%s %d" % (msg.text, msg.rssi), delay=55, wait=False)

    @ultra.on_content("ping")                  # feature 5 block form
    def pings(msg):
        pin0.write_digital(1)
        sleep(30)
        pin0.write_digital(0)

    display.show(Image.ARROW_S)
    ultra.run()


def flash(times=1, delay=100):
    for _ in range(times):
        display.show(Image.HEART)
        sleep(delay)
        display.clear()
        sleep(delay)


if ROLE == "sender":
    sender()
else:
    receiver()
