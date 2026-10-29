"""Melody player (feature 1).

Button A cycles through the melodies flashed with melodies.py, button B
replays the current one. Press A+B together to see how long the clip is.

Copy both ``ultra_expansion.py`` and ``melodies.py`` into the Python editor.
"""

from microbit import *
import ultra_expansion as ultra
import melodies          # registers startup, coin, alarm and robot

names = ultra.melody_names()
index = 0


def play_current():
    name = names[index]
    display.scroll(name, delay=45, wait=False)
    ultra.play_melody(name)


play_current()

while True:
    if button_a.was_pressed():
        index = (index + 1) % len(names)
        play_current()
    if button_b.was_pressed():
        play_current()
    if button_a.is_pressed() and button_b.is_pressed():
        display.scroll("%dms" % ultra.melody_duration(names[index]),
                       delay=45, wait=False)
        sleep(600)
    sleep(30)
