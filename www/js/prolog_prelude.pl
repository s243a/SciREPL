%% prolog_prelude.pl — SciREPL built-in helpers
%% Auto-loaded when the Prolog kernel initializes.

:- use_module(library(lists)).
:- use_module(library(readutil)).

%% show/1 — pretty-print a term with newline
show(X) :- print(X), nl.

%% show_all/1 — print each element of a list on its own line
show_all([]).
show_all([H|T]) :- show(H), show_all(T).

%% between/3 — generate integers in a range (if not already built-in)
%% Most SWI-Prolog builds include this, but just in case:
:- if(\+ current_predicate(between/3)).
between(Low, High, Low) :- Low =< High.
between(Low, High, X) :-
    Low < High,
    Low1 is Low + 1,
    between(Low1, High, X).
:- endif.

%% ── Notebook VFS helpers (/nb/) ──────────────────────────────
%% Cell properties are synced to /nb/In[N]/.code etc. before execution.

%% nb_read(+Cell, +Prop, -Value)
%% Read a cell property as a string.
%% Example: nb_read('In[1]', '.code', Code).
nb_read(Cell, Prop, Value) :-
    atomic_list_concat(['/nb/', Cell, '/', Prop], Path),
    read_file_to_string(Path, Value, []).

%% nb_code(+Cell, -Code) — shorthand for reading .code
nb_code(Cell, Code) :- nb_read(Cell, '.code', Code).

%% nb_output(+Cell, -Output) — shorthand for reading .output
nb_output(Cell, Output) :- nb_read(Cell, '.output', Output).

%% nb_language(+Cell, -Lang) — shorthand for reading .language
nb_language(Cell, Lang) :- nb_read(Cell, '.language', Lang).

%% nb_list(-Cells) — list cell directories under /nb/
nb_list(Cells) :-
    directory_files('/nb', AllFiles),
    exclude(is_dot, AllFiles, Cells).
is_dot('.').
is_dot('..').
