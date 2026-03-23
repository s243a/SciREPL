# Compute Pi — Educational Workbook Generation

## Overview
Multi-turn AI conversation that generates a complete educational workbook
about computing pi using the Archimedean polygon method, with comparison
to Newton-era series methods.

## Settings
- **Model:** Kimi K2.5 via OpenRouter (~$0.05 total for 7 prompts)
- **Security:** Open (no confirm dialogs for fast generation)
- **Auto-run:** Off (build all cells first, run at end)
- **Mirror:** On (creates conversation log alongside cells)

## Tip
Prefix prompts with: "Write explanations in markdown cells, not print statements."
This creates persistent documentation instead of ephemeral output.

## Prompts

### 1. Hexagon visualization
```
Draw a regular hexagon inscribed in a unit circle. Show the circle,
the hexagon, and lines from the center to each vertex. Use equal
aspect ratio so the hexagon looks correct. Title it "Regular Hexagon
Inscribed in Unit Circle".
```

### 2. Triangle and hexagon areas
```
Create a Python cell that:
1. Computes the area of one of the 6 equilateral triangles formed by
   the center and two adjacent vertices
2. Computes the area of the full hexagon (6 triangles)
3. Computes the area of the unit circle (pi * r^2 = pi)
4. Shows the area between the hexagon and the circle
5. Print all values and explain that the hexagon area (3*sqrt(3)/2)
   gives a lower bound for pi
```

### 3. N-gon bounds convergence
```
Create a cell that:
1. Generalizes from a hexagon to an N-sided regular polygon inscribed
   in a unit circle
2. Shows that the area of an N-gon inscribed in a unit circle is
   (N/2)*sin(2*pi/N)
3. This gives a lower bound for pi: pi >= (N/2)*sin(2*pi/N)
4. Similarly, a circumscribed N-gon gives an upper bound:
   pi <= N*tan(pi/N)
5. Compute both bounds for N = 6, 12, 24, 48, 96 in a table
6. Show how the bounds converge to pi as N increases
```

### 4. Digits of accuracy vs N
```
Create a cell that:
1. Derives how many sides N are needed so the error
   |pi - (N/2)*sin(2*pi/N)| < 10^(-d) for d digits of accuracy
2. For d = 1 through 10, compute the required N and the resulting
   approximation of pi
3. Show the digits of pi that are correct at each level
4. Use SymPy to display the formula symbolically and show in LaTeX
```

### 5. Iterative digit extraction
```
Create a cell that uses the previous cell's approach to iteratively
compute digits of pi:
1. Start with N=6 (hexagon)
2. Double N each iteration (12, 24, 48, 96, ...)
3. At each step, compute the lower bound (N/2)*sin(2*pi/N)
4. Use modular arithmetic to extract individual decimal digits
5. Stop when you have 15 correct digits
6. Print each iteration: N, approximation, and which digits are
   newly confirmed

Name this cell "pi_iteration_1".
```

### 6. Continuation cells
```
Create two more iteration cells that continue the computation:
1. Read the state from the previous cell using
   nb_read("pi_iteration_1", ".output")
2. Continue doubling N from where the previous cell left off
3. Each cell should compute 5 more confirmed digits of pi
4. Name them "pi_iteration_2" and "pi_iteration_3"
```

### 7. Newton's method comparison
```
Add a comparison section:
1. Create a markdown cell titled "## Newton's Method Comparison"
2. Explain the Leibniz series: pi/4 = 1 - 1/3 + 1/5 - 1/7 + ...
   and the Machin formula: pi/4 = 4*arctan(1/5) - arctan(1/239)
3. Create a Python cell comparing convergence rates
4. Print a table: Archimedes polygon vs Leibniz vs Machin — how many
   terms/iterations for 10 correct digits
5. Note the connection to spigot algorithms for digit extraction
6. Discuss how these relate to modern methods (BBP formula,
   Chudnovsky algorithm)
```

## Results
- 23 cells generated across 7 prompts
- Mix of Python code cells and markdown explanation cells
- Hexagon plot with equal aspect ratio via layout parameter
- SymPy LaTeX rendering for formulas
- Cross-cell references via nb_read for iterative computation

## Notes on mathematical approach
- The Archimedean method (polygon doubling) predates Newton by ~1900 years
- Convergence is O(1/N²) — slower than series methods
- The modular arithmetic digit extraction connects to the spigot algorithm
- Newton's binomial/arctan series converge exponentially
- Modern methods (Chudnovsky) add ~14 digits per term
