provider "aws" {
  default_tags {
    tags = {
      Project = "prevstat"
      Source  = "https://github.com/lasuillard-s/prevstat.git"
    }
  }
}
