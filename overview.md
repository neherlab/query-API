# Query-string builder of sequence data base

We need a web app that allows users to build a query string that allows to select a subset of viral isolates based on filters on metadata, dates, host, viral species, subtype, and other generic metadata fields.
We would like to adhere the the FIQL/RSQL standard with compact human readable query strings that avoid spaces and other characters that need URL-encoding.

## Special features of the query language

### Hierarchical lineage systems
We need custom operators like `descendentOf` to specify lineages that descent from a certain parental lineage (e.g. A, as well as A.1, A.2, A.3, A.1.1). This lineage hierarchy is available to the query backend.


### Strict and maybe-matching for incomplete dates
We would also need fuzzy matching semantics to cover dates that are only specified to the month or year. This should cover exact dates as well as ranges

### Virus and segment specific searches

The database contains sequences from different viral species and the genome of some species comes in multiple segments. Any search that refers to a property of the genome is there only permissible inconjuction with a specified organism. In addition, filters for properties like the length of a genomic segment need specification of the segment. Possible choices are `length.<segment> =ge= 1000` or `length{seg=segment} =ge= 1000`. For non-segmented virus, the segment can be omitted.


### Nucleotide and amino acid queries
To filter by state of specific nucleotide or amino acid, we need to specifiy the position in alignment coordinates defined by a reference sequence, and where applicable the segment or the CDS. Again, this could be achieved by `nuc{seg=<seg1>,ref=<ref1>,pos=3423}=='A'`. The downside is that this ends up being quite verbose. But if we want the user to be able to omit specify ref and seq when there is only a single reference and/or segment, contractions of `nuc.seg.ref.pos=A` become ambiguous (but should be resolved when the organism is specified).



## Requirements of the app

- allow users to generate query strings by adding groups of filters that can be connected by AND and OR
- checks the consistency and parseability (round trip)
- displays the minimally and strictly encoded strings
- translates the query into a json for alternative use in POST requests
- static web-app, to be deployed on gh pages


