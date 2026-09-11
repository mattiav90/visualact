ACT_HOME ?= /Users/mv479/tools/ACT/actflow_build

CXX = /opt/homebrew/opt/llvm/bin/clang++
CXXFLAGS = -std=c++17 -I$(ACT_HOME)/include
LDFLAGS = -L$(ACT_HOME)/lib -lact -lvlsilib -ldl

hier_dump: hier_dump.cc
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f hier_dump
