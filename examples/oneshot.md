# Oneshot requests

The deliverable is text in the chat: an explanation, a review, an opinion,
or code shown only as an illustration. The answerer replies in a single
streamed call with no tools.

## Explain a concept

```
@devteam explain how Promise.all differs from Promise.allSettled and when I would pick each
```

## Decode an error

```
@devteam what does "TypeError: Cannot read properties of undefined (reading 'map')" usually mean and what are the typical fixes?
```

## Explain a regex

```
@devteam what does this regex match: ^(?:[a-z0-9-]+\.)+[a-z]{2,}$
```

## Review a snippet (code as illustration, no file changes)

```
@devteam is there anything wrong with this function?

def average(numbers):
    return sum(numbers) / len(numbers)
```

## Compare approaches

```
@devteam should I use a Set or an array with includes() for membership checks on a few thousand strings? why?
```

Note: if a request like these also asks to create or change a file, triage
routes it to `planning` instead, even for a single small file.
