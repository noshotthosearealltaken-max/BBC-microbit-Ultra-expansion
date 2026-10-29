"""Radio-controlled robot with filtered commands (features 2, 4, 6, 8, 18-20).

Flash this to the *robot*. The base station sends command codes with::

    import ultra_expansion as ultra
    ultra.start(group=12)
    ultra.set_id(9)
    ultra.send_command(101, to=1)

Wiring: L298N IN1/IN2 -> P14/P13, IN3/IN4 -> P16/P15, servo on P1.
"""

from microbit import *
import ultra_expansion as ultra

ROBOT_ID = 1
BASE_ID = 9

ultra.start(group=12)
ultra.set_id(ROBOT_ID)
ultra.set_sender_filter([BASE_ID])      # feature 2: ignore everybody else
ultra.set_signal_threshold(-85)         # feature 4: drop far-away packets

left = ultra.Motor(pin13, pin14)
right = ultra.Motor(pin15, pin16)
ultra.set_motors(left, right)           # feature 20

arm = ultra.Servo(pin1)                 # feature 19

ultra.define_command(101, "turn left")
ultra.define_command(102, "turn right")
ultra.define_command(103, "stop")
ultra.define_command(104, "forward")
ultra.define_command(105, "arm up")
ultra.define_command(106, "arm down")


def show_command(name):
    display.scroll(name, delay=60, wait=False)


@ultra.on_command(101)
def _left(msg):
    ultra.turn_left(200)
    show_command("left")


@ultra.on_command(102)
def _right(msg):
    ultra.turn_right(200)
    show_command("right")


@ultra.on_command(103)
def _stop(msg):
    ultra.stop_motors()
    show_command("stop")


@ultra.on_command(104)
def _forward(msg):
    ultra.forward(255)
    show_command("go")


@ultra.on_command(105)
def _arm_up(msg):
    arm.set_angle(180)
    show_command("arm up")


@ultra.on_command(106)
def _arm_down(msg):
    arm.set_angle(0)
    show_command("arm down")


@ultra.on_message
def _fallback(msg):
    # Anything that is not a command code still shows up here.
    if msg.kind != ultra.KIND_CODE and msg.text:
        show_command(msg.text)


display.show(Image.ARROW_E)
ultra.run()
