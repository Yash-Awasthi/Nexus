import pytest
from hellotool import greet

def test_greet():
    assert greet("Alice") == "Hello, Alice!"
