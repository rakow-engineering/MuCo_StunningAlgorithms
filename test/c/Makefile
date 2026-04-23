CC     = gcc
CFLAGS = -Wall -Wextra -std=c99 -I../.. -lm
ROOT   = ../..

SRC = runner.c generated_tests.c \
      $(ROOT)/StunningHandlers.c \
      $(ROOT)/StunningAlgoHandler.c

.PHONY: all generate clean

all: generate test_runner

generate:
	python ../gen_c_tests.py

test_runner: $(SRC) test_harness.h generated_tests.h runner_cases.h
	$(CC) $(CFLAGS) -o test_runner $(SRC)

clean:
	del /f test_runner.exe test_runner generated_tests.h generated_tests.c runner_cases.h 2>NUL || true
