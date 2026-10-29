"""Array, variable and object playground (features 9-17).

Hold button A to step through the demos. Each one prints its result on the
LED display or scrolls a short summary.
"""

from microbit import *
import ultra_expansion as ultra

readings = [42, 7, 99, 15, 63, 8]
names = ["ada", "grace", "alan", "edsger"]
label = "ready"
counter = 12


def demo_unpack():
    # Feature 9: three values in one step.
    x, y, z = ultra.unpack(readings, 3)
    display.scroll("%d %d %d" % (x, y, z), delay=55)


def demo_dynamic_variables():
    # Feature 10: variables from array keys (pairs or plain values).
    ultra.make_variables({"speed": 180, "mode": "auto"})
    ultra.unpack_into(["a", "b"], readings)
    display.scroll("%d %s" % (ultra.speed, ultra.mode), delay=55)
    display.scroll("%d %d" % (ultra.a, ultra.b), delay=55)


def demo_object():
    # Feature 11: named properties from a flat array.
    player = ultra.array_to_object([120, 3, "sam"], ["score", "lives", "name"])
    player.score += 30
    display.scroll("%s %d %d" % (player.name, player.score, player.lives),
                   delay=55)


def demo_resets():
    # Features 12-14.
    global counter
    counter = 12
    ultra.reset_var("counter")          # 0
    ultra.reset_array(readings)         # empties the list in place
    ultra.reset_var("label")            # ""
    display.scroll("reset", delay=55)
    ultra.clear_variables(keep=["readings"])   # everything else back to zero


def demo_sort_filter_map():
    # Features 15-17.
    ordered = ultra.sort_array([3, 1, 2], descending=True)
    big = ultra.filter_array([42, 7, 99, 15], ultra.gt(20))
    doubled = ultra.map_array([1, 2, 3], ultra.multiply(2))
    display.scroll("%d%d%d" % (ordered[0], ordered[1], ordered[2]), delay=55)
    display.scroll("%d %d" % (big[0], big[1]), delay=55)
    display.scroll("%d%d%d" % (doubled[0], doubled[1], doubled[2]), delay=55)
    display.scroll(",".join(ultra.array_to_object(names).keys()), delay=55)


demos = [demo_unpack, demo_dynamic_variables, demo_object, demo_resets,
         demo_sort_filter_map]

display.show(Image.HAPPY)
while True:
    if button_a.was_pressed():
        demo = demos.pop(0)
        demos.append(demo)
        demo()
    sleep(50)
