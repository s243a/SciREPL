%% prolog_prelude.pl — SciREPL built-in helpers
%% Auto-loaded when the Prolog kernel initializes.

:- use_module(library(lists)).

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
